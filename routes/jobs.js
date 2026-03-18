/**
 * routes/jobs.js
 *
 * Admin-only endpoints to manually trigger background jobs.
 * Useful for testing, or forcing a run outside the cron schedule.
 */

const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const { runExpiryJob } = require('../jobs/expiryJob');

const router = express.Router();
router.use(authenticate, authorize('admin', 'superadmin'));

// POST /api/jobs/run-expiry
// Manually trigger the expiry job right now
router.post('/run-expiry', async (req, res, next) => {
  try {
    const summary = await runExpiryJob();
    return res.success(summary, 'Expiry job completed');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
