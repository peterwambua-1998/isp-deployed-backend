/**
 * routes/notifications.js
 *
 * GET  /api/notifications              — paginated list for the admin bell + page
 * GET  /api/notifications/unread-count — badge count (polled every 30s by frontend)
 * POST /api/notifications/:id/read     — mark one as read
 * POST /api/notifications/read-all     — mark all as read
 * DELETE /api/notifications/:id        — delete one (superadmin only)
 */

const express = require('express');
const { Op }  = require('sequelize');
const { Notification } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ── GET /api/notifications/unread-count ───────────────────────────────────────
// Polled frequently by the frontend bell. Returns a single number.
router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await Notification.count({
      where: { recipient_type: 'admin', read: false },
    });
    return res.json({ success: true, data: { count } });
  } catch (err) { next(err); }
});

// ── GET /api/notifications ────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      page  = 1,
      limit = 30,
      event,
      read,           // 'true' | 'false' | undefined
      recipient_type = 'admin',
    } = req.query;

    const where = { recipient_type };
    if (event !== undefined) where.event = event;
    if (read  !== undefined) where.read  = read === 'true';

    const offset = (Number(page) - 1) * Number(limit);
    const { count, rows } = await Notification.findAndCountAll({
      where,
      order:  [['createdAt', 'DESC']],
      limit:  Number(limit),
      offset,
    });

    return res.paginated(rows, count, page, limit);
  } catch (err) { next(err); }
});

// ── POST /api/notifications/:id/read ─────────────────────────────────────────
router.post('/:id/read', async (req, res, next) => {
  try {
    const notif = await Notification.findByPk(req.params.id);
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found' });
    await notif.update({ read: true, read_at: new Date() });
    return res.success(notif);
  } catch (err) { next(err); }
});

// ── POST /api/notifications/read-all ─────────────────────────────────────────
router.post('/read-all', async (req, res, next) => {
  try {
    await Notification.update(
      { read: true, read_at: new Date() },
      { where: { recipient_type: 'admin', read: false } }
    );
    return res.success(null, 'All notifications marked as read');
  } catch (err) { next(err); }
});

// ── DELETE /api/notifications/:id ─────────────────────────────────────────────
router.delete('/:id', authorize('superadmin'), async (req, res, next) => {
  try {
    const notif = await Notification.findByPk(req.params.id);
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found' });
    await notif.destroy();
    return res.success(null, 'Notification deleted');
  } catch (err) { next(err); }
});

module.exports = router;