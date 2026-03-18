const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { Customer, Package, Router, Payment, Session } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const radiusService  = require('../services/radiusService');
const coaService     = require('../services/coaService');
const sms            = require('../services/smsService');
const notifications  = require('../services/notificationService');
const logger         = require('../config/logger');
const { calcExpiry } = require('../utils/duration');

const router = express.Router();
router.use(authenticate);

// ── Helper: find the NAS IP for a customer's router ───────────────────────
const getNasIp = async (customer) => {
  if (!customer.router_id) return null;
  const routerDevice = await Router.findByPk(customer.router_id);
  return routerDevice?.ip_address || null;
};

// GET /api/customers  — list with pagination + search
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, status, service_type } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (search) {
      where[Op.or] = [
        { full_name: { [Op.like]: `%${search}%` } },
        { username: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
      ];
    }
    if (status) where.status = status;
    if (service_type) where.service_type = service_type;

    const { count, rows } = await Customer.findAndCountAll({
      where,
      include: [{ model: Package, attributes: ['id', 'name', 'price', 'speed_download', 'speed_upload', 'duration_days', 'duration_minutes'] }],
      limit: Number(limit),
      offset,
      order: [['created_at', 'DESC']],
      attributes: { exclude: ['password'] },
    });

    return res.paginated(rows, count, page, limit);
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id, {
      include: [Package, Router],
      attributes: { exclude: ['password'] },
    });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
    return res.success(customer);
  } catch (err) {
    next(err);
  }
});

// POST /api/customers  — create customer + sync to RADIUS
router.post(
  '/',
  [
    body('full_name').notEmpty(),
    body('phone').notEmpty(),
    body('username').notEmpty().isAlphanumeric(),
    body('password').isLength({ min: 4 }),
    body('service_type').isIn(['hotspot', 'pppoe']),
    body('package_id').isUUID(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const pkg = await Package.findByPk(req.body.package_id);
      if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });

      const expiry = calcExpiry(pkg);

      const customer = await Customer.create({ ...req.body, expiry_date: expiry, status: 'active' });
      await radiusService.createUser(customer, pkg);

      // Notifications — welcome SMS/email to customer + admin bell — non-blocking
      notifications.notifyCustomerCreated({ customer, pkg })
        .catch(err => logger.warn(`Customer created notification failed: ${err.message}`));

      return res.success(customer, 'Customer created', 201);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/customers/:id
// If package changed and customer is online → CoA speed change (no disconnect)
router.put('/:id', async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const oldPackageId = customer.package_id;
    const disallowed = ['id', 'created_at', 'updated_at'];
    disallowed.forEach((k) => delete req.body[k]);

    await customer.update(req.body);

    const packageChanged = req.body.package_id && req.body.package_id !== oldPackageId;

    if (packageChanged) {
      const newPkg = await Package.findByPk(req.body.package_id);
      if (newPkg) {
        // Update RADIUS group reply (speed limits for the new package)
        await radiusService.updateUser(customer, newPkg);

        // If customer is currently online, push new speed via CoA — no disconnect
        const nasIp = await getNasIp(customer);
        if (nasIp) {
          const activeSession = await Session.findOne({
            where: { username: customer.username, is_active: true },
          });

          if (activeSession) {
            const coaResult = await coaService.changeSpeed(
              nasIp,
              customer.username,
              activeSession.session_id,
              newPkg.speed_upload,
              newPkg.speed_download
            );
            return res.success(
              { customer, coa: coaResult },
              coaResult.success
                ? `Customer updated — speed changed to ${coaResult.rate_limit} live`
                : `Customer updated — speed will apply on next login (CoA failed: ${coaResult.message})`
            );
          }
        }
      }
    }

    return res.success(customer, 'Customer updated');
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/suspend
// Disables RADIUS + sends CoA Disconnect to kill any live session immediately
router.post('/:id/suspend', authorize('admin', 'superadmin'), async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    await customer.update({ status: 'suspended' });

    // 1. Block future logins in RADIUS
    await radiusService.disableUser(customer.username);

    // 2. Kill any live session right now via CoA Disconnect
    const nasIp = await getNasIp(customer);
    let coaResult = null;
    if (nasIp) {
      const activeSession = await Session.findOne({
        where: { username: customer.username, is_active: true },
      });
      coaResult = await coaService.disconnectUser(
        nasIp,
        customer.username,
        activeSession?.session_id
      );
    }

    // 3. Notify customer via SMS — non-blocking
    const reason = req.body?.reason || '';
    sms.accountSuspended(customer, reason).catch(() => {});

    return res.success(
      { coa: coaResult },
      coaResult?.success
        ? 'Customer suspended and live session terminated'
        : nasIp
          ? `Customer suspended — RADIUS blocked (CoA disconnect: ${coaResult?.message})`
          : 'Customer suspended (no router assigned — RADIUS blocked only)'
    );

    // Notify customer — non-blocking
    if (customer.phone) {
      sms.sendAccountSuspended(customer.phone, { fullName: customer.full_name }).catch(() => {});
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/activate
router.post('/:id/activate', authorize('admin', 'superadmin'), async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const pkg = await Package.findByPk(customer.package_id);
    await customer.update({ status: 'active' });
    await radiusService.enableUser(customer.username, pkg);

    // Notify customer — non-blocking
    if (pkg) sms.accountActivated(customer, pkg, customer.expiry_date).catch(() => {});

    return res.success(null, 'Customer activated — they can now log in');
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/kick
// Admin manually disconnects a customer's live session without suspending them
// They can immediately reconnect — useful for forcing a re-auth
router.post('/:id/kick', authorize('admin', 'superadmin'), async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const nasIp = await getNasIp(customer);
    if (!nasIp) {
      return res.status(400).json({ success: false, message: 'No router assigned to this customer' });
    }

    const activeSession = await Session.findOne({
      where: { username: customer.username, is_active: true },
    });

    if (!activeSession) {
      return res.status(400).json({ success: false, message: 'Customer has no active session' });
    }

    const coaResult = await coaService.disconnectUser(nasIp, customer.username, activeSession.session_id);

    return res.success(
      { coa: coaResult, session_id: activeSession.session_id },
      coaResult.success ? 'Session terminated — customer can reconnect' : `Kick failed: ${coaResult.message}`
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/sessions
router.get('/:id/sessions', async (req, res, next) => {
  try {
    const sessions = await Session.findAll({
      where: { customer_id: req.params.id },
      order: [['created_at', 'DESC']],
      limit: 50,
    });
    return res.success(sessions);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customers/:id
// Disconnects any live session, removes from RADIUS, deletes record
router.delete('/:id', authorize('superadmin'), async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    // Disconnect live session if online
    const nasIp = await getNasIp(customer);
    if (nasIp) {
      const activeSession = await Session.findOne({ where: { username: customer.username, is_active: true } });
      if (activeSession) {
        await coaService.disconnectUser(nasIp, customer.username, activeSession.session_id);
      }
    }

    await radiusService.deleteUser(customer.username);
    await customer.destroy();

    return res.success(null, 'Customer deleted');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// GET /api/customers  — list with pagination + search
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, status, service_type } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (search) {
      where[Op.or] = [
        { full_name: { [Op.like]: `%${search}%` } },
        { username: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
      ];
    }
    if (status) where.status = status;
    if (service_type) where.service_type = service_type;

    const { count, rows } = await Customer.findAndCountAll({
      where,
      include: [{ model: Package, attributes: ['id', 'name', 'price', 'speed_download', 'speed_upload', 'duration_days', 'duration_minutes'] }],
      limit: Number(limit),
      offset,
      order: [['created_at', 'DESC']],
      attributes: { exclude: ['password'] },
    });

    return res.paginated(rows, count, page, limit);
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id, {
      include: [Package, Router],
      attributes: { exclude: ['password'] },
    });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
    return res.success(customer);
  } catch (err) {
    next(err);
  }
});

// POST /api/customers  — create customer + sync to RADIUS
router.post(
  '/',
  [
    body('full_name').notEmpty(),
    body('phone').notEmpty(),
    body('username').notEmpty().isAlphanumeric(),
    body('password').isLength({ min: 4 }),
    body('service_type').isIn(['hotspot', 'pppoe']),
    body('package_id').isUUID(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const pkg = await Package.findByPk(req.body.package_id);
      if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });

      // Set expiry based on package duration (minute-based or day-based)
      const expiry = calcExpiry(pkg);

      const customer = await Customer.create({ ...req.body, expiry_date: expiry, status: 'active' });

      // Sync to FreeRADIUS tables
      await radiusService.createUser(customer, pkg);

      return res.success(customer, 'Customer created', 201);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/customers/:id
router.put('/:id', async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const disallowed = ['id', 'created_at', 'updated_at'];
    disallowed.forEach((k) => delete req.body[k]);

    await customer.update(req.body);

    // If package changed, update RADIUS attributes
    if (req.body.package_id) {
      const pkg = await Package.findByPk(req.body.package_id);
      if (pkg) await radiusService.updateUser(customer, pkg);
    }

    return res.success(customer, 'Customer updated');
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/suspend
router.post('/:id/suspend', authorize('admin', 'superadmin'), async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    await customer.update({ status: 'suspended' });
    await radiusService.disableUser(customer.username);

    return res.success(null, 'Customer suspended');
  } catch (err) {
    next(err);
  }
});

// POST /api/customers/:id/activate
router.post('/:id/activate', authorize('admin', 'superadmin'), async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const pkg = await Package.findByPk(customer.package_id);
    await customer.update({ status: 'active' });
    await radiusService.enableUser(customer.username, pkg);

    return res.success(null, 'Customer activated');
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id/sessions
router.get('/:id/sessions', async (req, res, next) => {
  try {
    const sessions = await Session.findAll({
      where: { customer_id: req.params.id },
      order: [['created_at', 'DESC']],
      limit: 50,
    });
    return res.success(sessions);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/customers/:id
router.delete('/:id', authorize('superadmin'), async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    await radiusService.deleteUser(customer.username);
    await customer.destroy();

    return res.success(null, 'Customer deleted');
  } catch (err) {
    next(err);
  }
});

module.exports = router;