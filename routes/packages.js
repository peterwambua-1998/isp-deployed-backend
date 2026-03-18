const express = require('express');
const { body, validationResult } = require('express-validator');
const { Package } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const radiusService = require('../services/radiusService');
const logger = require('../config/logger');

const router = express.Router();
router.use(authenticate);

// GET /api/packages
router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query;
    const where = { is_active: true };
    if (type) where.type = type;
    const packages = await Package.findAll({ where, order: [['price', 'ASC']] });
   
    return res.success(packages);
  } catch (err) { next(err); }
});

// GET /api/packages/:id
router.get('/:id', async (req, res, next) => {
  try {
    const pkg = await Package.findByPk(req.params.id);
    if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });
    return res.success(pkg);
  } catch (err) { next(err); }
});

// POST /api/packages
router.post(
  '/',
  authorize('admin', 'superadmin'),
  [
    body('name').trim().notEmpty().withMessage('Package name is required'),
    body('type').isIn(['hotspot', 'pppoe']).withMessage('Type must be hotspot or pppoe'),
    body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),

    // Duration validation: must have either duration_days OR duration_minutes (not both zero)
    body('duration_days')
      .isInt({ min: 0 }).withMessage('duration_days must be a non-negative integer')
      .default(0),
    body('duration_minutes')
      .isInt({ min: 0 }).withMessage('duration_minutes must be a non-negative integer')
      .default(0),
    body().custom((_, { req }) => {
      const days    = parseInt(req.body.duration_days    || 0);
      const minutes = parseInt(req.body.duration_minutes || 0);
      if (days === 0 && minutes === 0) {
        throw new Error('Package must have either duration_days or duration_minutes set (cannot both be 0)');
      }
      if (days > 0 && minutes > 0) {
        throw new Error('Set either duration_days OR duration_minutes — not both');
      }
      return true;
    }),

    body('speed_download').isInt({ min: 128 }).withMessage('Download speed must be at least 128 Kbps'),
    body('speed_upload').isInt({ min: 128 }).withMessage('Upload speed must be at least 128 Kbps'),
    body('data_limit_mb').optional().isInt({ min: 0 }).default(0),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ success: false, errors: errors.array() });

      const pkg = await Package.create({
        name:             req.body.name,
        type:             req.body.type,
        price:            req.body.price,
        duration_days:    parseInt(req.body.duration_days    || 0),
        duration_minutes: parseInt(req.body.duration_minutes || 0),
        speed_download:   parseInt(req.body.speed_download),
        speed_upload:     parseInt(req.body.speed_upload),
        data_limit_mb:    parseInt(req.body.data_limit_mb    || 0),
        is_active:        true,
      });

      // Sync speed profile to RADIUS radgroupreply so any new customer
      // on this package gets the right rate limit immediately
      try {
        await radiusService.syncPackageGroup(pkg);
        logger.info(`RADIUS group synced for new package: ${pkg.name}`);
      } catch (err) {
        logger.warn(`Package created but RADIUS group sync failed: ${err.message}`);
      }

      return res.success(pkg, 'Package created', 201);
    } catch (err) { 
      console.log(err);
      next(err); 
    }
  }
);

// PUT /api/packages/:id
router.put(
  '/:id',
  authorize('admin', 'superadmin'),
  [
    body('duration_days').optional().isInt({ min: 0 }),
    body('duration_minutes').optional().isInt({ min: 0 }),
    body('speed_download').optional().isInt({ min: 128 }),
    body('speed_upload').optional().isInt({ min: 128 }),
    body('price').optional().isFloat({ min: 0 }),
    body().custom((_, { req }) => {
      const days    = req.body.duration_days    !== undefined ? parseInt(req.body.duration_days)    : undefined;
      const minutes = req.body.duration_minutes !== undefined ? parseInt(req.body.duration_minutes) : undefined;
      // Only validate if both are provided in the update
      if (days !== undefined && minutes !== undefined) {
        if (days === 0 && minutes === 0) {
          throw new Error('Package must have either duration_days or duration_minutes (not both 0)');
        }
        if (days > 0 && minutes > 0) {
          throw new Error('Set either duration_days OR duration_minutes — not both');
        }
      }
      return true;
    }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ success: false, errors: errors.array() });

      const pkg = await Package.findByPk(req.params.id);
      if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });

      const speedChanged =
        (req.body.speed_download !== undefined && req.body.speed_download !== pkg.speed_download) ||
        (req.body.speed_upload   !== undefined && req.body.speed_upload   !== pkg.speed_upload);

      await pkg.update(req.body);

      // If speed changed, re-sync the RADIUS group so ALL existing customers
      // on this package immediately get the new rate limit
      if (speedChanged) {
        try {
          await radiusService.syncPackageGroup(pkg);
          logger.info(`RADIUS group re-synced after speed change: ${pkg.name}`);
        } catch (err) {
          logger.warn(`Package updated but RADIUS group sync failed: ${err.message}`);
        }
      }

      return res.success(pkg, 'Package updated');
    } catch (err) { next(err); }
  }
);

// DELETE /api/packages/:id  (soft delete — keeps historical data intact)
router.delete('/:id', authorize('superadmin'), async (req, res, next) => {
  try {
    const pkg = await Package.findByPk(req.params.id);
    if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });
    await pkg.update({ is_active: false });
    return res.success(null, 'Package deactivated');
  } catch (err) { next(err); }
});

module.exports = router;