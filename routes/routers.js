/**
 * routes/routers.js
 *
 * All protected routes for MikroTik device management.
 * Every route here requires a valid admin JWT (authenticate middleware).
 *
 * The PUBLIC provisioning endpoints (GET /provision/:token and
 * POST /provision/:token/callback) live in routes/provision.js
 * so they never touch this auth middleware.
 *
 * Wizard flow:
 *   1. POST   /api/routers              — create router record (name + options only)
 *   2. POST   /api/routers/:id/provision — generate the MikroTik terminal command
 *      [MikroTik runs the command → hits /provision/:token → POSTs back to /provision/:token/callback]
 *      [Frontend polls GET /api/routers/:id every 5s — when is_provisioned=true it auto-advances]
 *   3. GET    /api/routers/:id/configure-services/stream — SSE: full service config
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { Router, Session, Customer } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const mikrotikService = require('../services/mikrotikService');
const radiusService = require('../services/radiusService');
const logger = require('../config/logger');
const { sendRouterOffline } = require('../services/smsService');
const notifications   = require('../services/notificationService');

const router = express.Router();
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Fixed-path routes (/radius/nas, /radius/sync-all) MUST be defined
// BEFORE the dynamic /:id route, otherwise Express matches them as id="radius".
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/routers/radius/nas — audit RADIUS NAS table vs billing DB
router.get('/radius/nas', authorize('admin', 'superadmin'), async (req, res, next) => {
  try {
    const [billingRouters, nasEntries] = await Promise.all([
      Router.findAll({
        where: { is_provisioned: true },
        attributes: ['id', 'name', 'ip_address', 'status'],
      }),
      radiusService.listNas(),
    ]);

    const nasIps = new Set(nasEntries.map(n => n.nasname));
    const billingIps = new Set(billingRouters.map(r => r.ip_address));

    const outOfSync = billingRouters
      .filter(r => !nasIps.has(r.ip_address))
      .map(r => ({ ...r.toJSON(), issue: 'Missing from RADIUS nas table' }));

    const orphanNas = nasEntries
      .filter(n => !billingIps.has(n.nasname))
      .map(n => ({ nasname: n.nasname, shortname: n.shortname, issue: 'In RADIUS but not in billing' }));

    return res.success({
      nas_entries: nasEntries,
      billing_routers: billingRouters,
      out_of_sync: outOfSync,
      orphan_nas: orphanNas,
      all_synced: outOfSync.length === 0 && orphanNas.length === 0,
    });
  } catch (err) { next(err); }
});

// POST /api/routers/radius/sync-all — force re-sync all provisioned routers into RADIUS
router.post('/radius/sync-all', authorize('superadmin'), async (req, res, next) => {
  try {
    const routers = await Router.findAll({ where: { is_provisioned: true } });
    const results = { synced: [], failed: [] };

    for (const r of routers) {
      try {
        await radiusService.registerNas(r);
        results.synced.push({ id: r.id, name: r.name, ip: r.ip_address });
      } catch (err) {
        results.failed.push({ id: r.id, name: r.name, ip: r.ip_address, error: err.message });
      }
    }

    return res.success(
      results,
      `Sync complete: ${results.synced.length} synced, ${results.failed.length} failed`
    );
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────

// GET /api/routers — list all routers
router.get('/', async (req, res, next) => {
  try {
    const routers = await Router.findAll({ order: [['created_at', 'DESC']] });
    return res.success(routers);
  } catch (err) { next(err); }
});

/**
 * POST /api/routers
 * Step 1 of wizard — admin enters ONLY: name, service_types, ethernet_ports, anti_sharing.
 * No IP address, no credentials — those arrive later via the provision callback.
 */
router.post(
  '/',
  authorize('admin', 'superadmin'),
  [
    body('name')
      .trim().notEmpty().withMessage('Router name is required'),
    body('service_types')
      .isArray({ min: 1 }).withMessage('Select at least one service type (pppoe or hotspot)'),
    body('service_types.*')
      .isIn(['pppoe', 'hotspot']).withMessage('service_types must be pppoe or hotspot'),
    body('ethernet_ports')
      .optional().isArray(),
    body('anti_sharing')
      .optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ success: false, errors: errors.array() });

      const routerDevice = await Router.create({
        name: req.body.name,
        service_types: req.body.service_types,
        ethernet_ports: req.body.ethernet_ports || [],
        anti_sharing: req.body.anti_sharing || false,
        location: req.body.location || null,
        // Placeholders — overwritten when provision callback fires
        ip_address: '0.0.0.0',
        api_username: 'pending',
        api_password: 'pending',
        status: 'unprovisioned',
        is_provisioned: false,
      });

      logger.info(`Router created: "${routerDevice.name}" (${routerDevice.id}) — awaiting provisioning`);
      return res.success(routerDevice, 'Router created. Generate the provisioning command next.', 201);
    } catch (err) { next(err); }
  }
);

// GET /api/routers/:id — single router (frontend polls this during step 2)
router.get('/:id', async (req, res, next) => {
  try {
    const routerDevice = await Router.findByPk(req.params.id);
    if (!routerDevice)
      return res.status(404).json({ success: false, message: 'Router not found' });
    return res.success(routerDevice);
  } catch (err) { next(err); }
});

// PUT /api/routers/:id — update non-credential fields (name, location, options)
router.put('/:id', authorize('admin', 'superadmin'), async (req, res, next) => {
  try {
    const routerDevice = await Router.findByPk(req.params.id);
    if (!routerDevice)
      return res.status(404).json({ success: false, message: 'Router not found' });

    // Whitelist: never allow direct IP/credential updates — those only come from callback
    const allowed = ['name', 'location', 'service_types', 'ethernet_ports', 'anti_sharing', 'api_port'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    await routerDevice.update(updates);
    return res.success(routerDevice, 'Router updated');
  } catch (err) { next(err); }
});

// DELETE /api/routers/:id
router.delete('/:id', authorize('superadmin'), async (req, res, next) => {
  try {
    const routerDevice = await Router.findByPk(req.params.id);
    if (!routerDevice)
      return res.status(404).json({ success: false, message: 'Router not found' });

    const { ip_address, name } = routerDevice;
    await routerDevice.destroy();

    if (ip_address && ip_address !== '0.0.0.0') {
      try {
        await radiusService.removeNas(ip_address);
        logger.info(`RADIUS NAS removed for deleted router "${name}" (${ip_address})`);
      } catch (err) {
        logger.warn(`Router deleted but RADIUS NAS removal failed: ${err.message}`);
      }
    }

    return res.success(null, 'Router deleted');
  } catch (err) { next(err); }
});

/**
 * POST /api/routers/:id/provision
 * Step 2 of wizard — generates the JWT-signed MikroTik terminal command.
 * Frontend copies this and admin pastes it into the MikroTik terminal.
 * Token expires in 1 hour. Can be regenerated by calling this again.
 */
router.post('/:id/provision', authorize('admin', 'superadmin'), async (req, res, next) => {
  try {
    const routerDevice = await Router.findByPk(req.params.id);
    if (!routerDevice)
      return res.status(404).json({ success: false, message: 'Router not found' });

    const token = jwt.sign(
      { router_id: routerDevice.id, action: 'provision' },
      process.env.PROVISION_SECRET,
      { expiresIn: '1h' }
    );

    // PROVISION_BASE_URL must point to where provision.js is mounted, e.g.:
    //   https://billing.yourdomain.com/provision
    const baseUrl = (process.env.PROVISION_BASE_URL).replace(/\/$/, '');
    const scriptUrl = `${baseUrl}/${token}`;

    // The exact command the admin pastes into the MikroTik terminal
    const command = `/tool fetch mode=http url="${scriptUrl}" dst-path=billing.rsc;:delay 2s;/import billing.rsc;`;

    logger.info(`Provision command generated for "${routerDevice.name}"`);

    return res.success(
      { command, token, expires_in: '1 hour', script_url: scriptUrl },
      'Provisioning command generated — paste into MikroTik terminal'
    );
  } catch (err) { next(err); }
});

/**
 * GET /api/routers/:id/sessions
 * Returns active sessions from our billing DB for this router's IP.
 * Used on the router detail page "Active Sessions" tab.
 */
router.get('/:id/sessions', async (req, res, next) => {
  try {
    const routerDevice = await Router.findByPk(req.params.id);
    if (!routerDevice)
      return res.status(404).json({ success: false, message: 'Router not found' });

    // If router not yet provisioned, return empty list rather than querying with '0.0.0.0'
    if (!routerDevice.is_provisioned || routerDevice.ip_address === '0.0.0.0') {
      return res.success([], 'Router not yet provisioned');
    }

    const sessions = await Session.findAll({
      where: { nas_ip: routerDevice.ip_address, is_active: true },
      order: [['started_at', 'DESC']],
      limit: 100,
    });

    return res.success(sessions);
  } catch (err) { next(err); }
});

/**
 * POST /api/routers/:id/ping
 * Tests the MikroTik API connection and updates status + resource stats.
 */
router.post('/:id/ping', authorize('admin', 'superadmin'), async (req, res, next) => {
  console.log('pinging');
  try {
    const routerDevice = await Router.findByPk(req.params.id);
    if (!routerDevice)
      return res.status(404).json({ success: false, message: 'Router not found' });

    if (!routerDevice.is_provisioned || routerDevice.ip_address === '0.0.0.0') {
      return res.status(400).json({
        success: false,
        message: 'Router not yet provisioned — complete step 2 first',
      });
    }

    const result = await mikrotikService.ping(routerDevice);
    const update = { last_seen: new Date(), status: result.online ? 'online' : 'offline' };

    if (result.online) {
      try {
        const stats = await mikrotikService.getResourceStats(routerDevice);
        update.cpu_usage = stats.cpu_load;
        update.memory_usage = stats.memory_percent;
        update.disk_usage = stats.disk_percent;
      } catch (_) { /* non-fatal */ }
    }

    await routerDevice.update(update);
    if (result.online == false) {
      sendRouterOffline(routerDevice);
      notifications.notifyRouterOffline({ router: r }).then(() => console.log('email sent')).catch(() => { });
    }
    return res.success({ ...result, ...update }, result.online ? 'Router is online' : 'Router is offline');
  } catch (err) { next(err); }
});

/**
 * GET /api/routers/:id/configure-services/stream
 * Step 3 of wizard — SSE stream of the full PPPoE/Hotspot/firewall setup.
 *
 * Reads service_types, ethernet_ports, anti_sharing from the saved router record —
 * no need to pass them again, they were saved in step 1.
 *
 * Requires router to be provisioned (is_provisioned=true) so we have a real IP
 * and API credentials to connect with.
 */
router.get('/:id/configure-services/stream', authorize('admin', 'superadmin'), async (req, res) => {
  let ended = false;

  try {
    const routerDevice = await Router.findByPk(req.params.id);

    if (!routerDevice) {
      return res.status(404).json({ success: false, message: 'Router not found' });
    }

    if (!routerDevice.is_provisioned || routerDevice.ip_address === '0.0.0.0') {
      return res.status(400).json({
        success: false,
        message: 'Router must be provisioned (step 2) before configuring services',
      });
    }

    // ── SSE setup ─────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // critical for nginx — disables proxy buffering

    if (res.flushHeaders) res.flushHeaders();

    const send = (type, message) => {
      if (ended) return;
      // All events use the "data:" line format that the frontend reads
      res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
      // Force flush for nginx/proxies that buffer SSE
      if (res.flush) res.flush();
    };

    // If the client disconnects (browser closed / navigated away), set the flag
    // so onLog calls after that point are silently dropped instead of throwing
    req.on('close', () => { ended = true; });

    send('info', `Connecting to ${routerDevice.name} (${routerDevice.ip_address})...`);

    // Pull wizard selections from DB — saved at step 1
    const serviceTypes = routerDevice.service_types || ['pppoe'];
    const etherPorts = routerDevice.ethernet_ports || [];
    const antiSharing = routerDevice.anti_sharing || false;

    const result = await mikrotikService.configureServices(
      routerDevice,
      {
        enablePppoe: serviceTypes.includes('pppoe'),
        enableHotspot: serviceTypes.includes('hotspot'),
        antiSharing,
        ports: etherPorts,
        radiusIp: process.env.RADIUS_IP || '127.0.0.1',
        radiusSecret: process.env.RADIUS_SHARED_SECRET || 'radiussecret',
        bridgeGateway: '10.10.10.1',
        bridgeNetwork: '10.10.10.0/24',
        dhcpRangeStart: '10.10.10.10',
        dhcpRangeEnd: '10.10.10.254',
      },
      // onLog fires for every step — stream each one to the browser
      (entry) => send(entry.status === 'error' ? 'error' : entry.status === 'success' ? 'success' : 'info', entry.message)
    );

    if (result.success) {
      // Update router status and grab resource stats while we're connected
      const update = { status: 'online', last_seen: new Date() };
      try {
        const stats = await mikrotikService.getResourceStats(routerDevice);
        update.cpu_usage = stats.cpu_load;
        update.memory_usage = stats.memory_percent;
        update.disk_usage = stats.disk_percent;
      } catch (_) { }
      await routerDevice.update(update);
    }

    send(
      result.success ? 'success' : 'error',
      result.success
        ? '✅ Configuration complete! Router is ready.'
        : `❌ Configuration failed: ${result.error}`
    );

  } catch (err) {
    logger.error('configure-services/stream error:', err);
    if (!ended) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }
  } finally {
    ended = true;
    res.end();
  }
});

module.exports = router;