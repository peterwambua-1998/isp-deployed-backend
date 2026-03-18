/**
 * routes/settings.js
 *
 * GET  /api/settings/:category        — get all settings for a category
 *                                       secrets are masked (value replaced with '••••••')
 * PUT  /api/settings/:category        — save all settings for a category (superadmin only)
 * POST /api/settings/mpesa/test       — test M-Pesa credentials
 */

const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const settingsService = require('../services/settingsService');
const { Setting }     = require('../models');
const logger          = require('../config/logger');

const router = express.Router();
router.use(authenticate);

// ── PUT /api/settings/:category ───────────────────────────────────────────────
// Saves settings. For secret fields: if the client sends empty string,
// we keep the existing value (so blanking a field doesn't wipe a saved secret).
router.put('/:category', authorize('superadmin', 'admin'), async (req, res, next) => {
  try {
    const { category } = req.params;
    const incoming     = req.body; // { consumer_key: 'abc', shortcode: '174379', ... }

    for (const [key, value] of Object.entries(incoming)) {
      // For secret fields, skip update if value is empty (preserve existing)
      const row = await Setting.findOne({ where: { category, key } });
      if (row?.is_secret && (value === '' || value === null || value === undefined)) {
        continue; // keep existing secret
      }
      await Setting.upsert({ category, key, value: String(value ?? '') });
    }

    // Clear cache for this category
    settingsService.cacheClear(category);
    logger.info(`Settings updated: category=${category} by admin ${req.user?.id}`);

    return res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) { next(err); }
});

// ── GET /api/settings/packages/speeds ────────────────────────────────────────
router.get('/packages/speeds', async (req, res, next) => {
  try {
    const raw  = await settingsService.get('packages', 'speed_presets', '[]');
    const list = JSON.parse(raw || '[]');
    return res.json({ success: true, data: list });
  } catch (err) { next(err); }
});

// ── PUT /api/settings/packages/speeds ────────────────────────────────────────
router.put('/packages/speeds', authorize('superadmin', 'admin'), async (req, res, next) => {
  try {
    const { speeds } = req.body; // array of { label, download, upload }
    if (!Array.isArray(speeds)) {
      return res.status(400).json({ success: false, message: 'speeds must be an array' });
    }
    for (const s of speeds) {
      if (!s.label) return res.status(400).json({ success: false, message: 'Each speed must have a label' });
      if (!s.download || s.download < 128) return res.status(400).json({ success: false, message: `"${s.label}" download must be at least 128 Kbps` });
      if (!s.upload   || s.upload   < 128) return res.status(400).json({ success: false, message: `"${s.label}" upload must be at least 128 Kbps` });
    }
    await settingsService.set('packages', 'speed_presets', JSON.stringify(speeds));
    return res.json({ success: true, message: 'Speed presets saved', data: speeds });
  } catch (err) { next(err); }
});

// ── GET /api/settings/packages/durations ─────────────────────────────────────
// Public-ish — packages page needs this without superadmin restriction
router.get('/packages/durations', async (req, res, next) => {
  try {
    const raw  = await settingsService.get('packages', 'duration_options', '[]');
    const list = JSON.parse(raw || '[]');
    return res.json({ success: true, data: list });
  } catch (err) { next(err); }
});

// ── PUT /api/settings/packages/durations ──────────────────────────────────────
router.put('/packages/durations', authorize('superadmin', 'admin'), async (req, res, next) => {
  try {
    const { durations } = req.body; // array of { label, days, minutes }
    if (!Array.isArray(durations)) {
      return res.status(400).json({ success: false, message: 'durations must be an array' });
    }
    // Validate each entry
    for (const d of durations) {
      if (!d.label || typeof d.label !== 'string') {
        return res.status(400).json({ success: false, message: 'Each duration must have a label' });
      }
      if (d.days === 0 && d.minutes === 0) {
        return res.status(400).json({ success: false, message: `Duration "${d.label}" must have days or minutes > 0` });
      }
      if (d.days > 0 && d.minutes > 0) {
        return res.status(400).json({ success: false, message: `Duration "${d.label}" cannot have both days and minutes` });
      }
    }
    await settingsService.set('packages', 'duration_options', JSON.stringify(durations));
    return res.json({ success: true, message: 'Duration options saved', data: durations });
  } catch (err) { next(err); }
});

// ── GET /api/settings/:category ───────────────────────────────────────────────
// Returns all settings for the category.
// Secret values are masked — client never sees raw keys/passwords.
// A special `_has_value` boolean is returned so UI can show "configured" state.
router.get('/:category', async (req, res, next) => {
  try {
    const { category } = req.params;
    const rows = await Setting.findAll({ where: { category }, order: [['key', 'ASC']] });

    const data = {};
    for (const row of rows) {
      data[row.key] = {
        value:     row.is_secret ? '' : (row.value || ''),  // mask secrets
        has_value: !!(row.value && row.value.length > 0),   // true if configured
        is_secret: row.is_secret,
        label:     row.label,
      };
    }

    return res.json({ success: true, data });
  } catch (err) { next(err); }
});



// ── POST /api/settings/sms/test ───────────────────────────────────────────────
router.post('/sms/test', authorize('superadmin', 'admin'), async (req, res, next) => {
  try {
    const smsService = require('../services/smsService');
    const result = await smsService.testConnection(req.body.phone || null);
    return res.json({ success: result.success, message: result.message });
  } catch (err) { 
    next(err); 
  }
});

// ── POST /api/settings/mpesa/test ─────────────────────────────────────────────
router.post('/mpesa/test', authorize('superadmin', 'admin'), async (req, res, next) => {
  try {
    const mpesaService = require('../services/mpesaService');
    const result = await mpesaService.testConnection();
    return res.json({ success: result.success, message: result.message });
  } catch (err) { next(err); }
});

module.exports = router;