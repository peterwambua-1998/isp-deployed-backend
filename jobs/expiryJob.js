/**
 * jobs/expiryJob.js
 *
 * Three schedulers:
 *
 * 1. Minute expiry job  — every minute — handles ALL expired customers
 *    regardless of whether they are minute-based or day-based.
 *    This replaces the old split "daily" vs "per-minute" approach:
 *    - Day-based customers expire at 23:59:59 and are caught on the next
 *      minute tick after midnight.
 *    - Minute-based customers are caught within 1 minute of expiry.
 *    One job, one query, no duplication.
 *
 * 2. Expiry warning job — 10:00 and 18:00 daily — finds day-based customers
 *    expiring within 24 hours and sends them an SMS warning.
 *    (Minute-based packs are too short to warn in advance.)
 *
 * 3. Data cap warning   — handled inline in routes/accounting.js when
 *    the RADIUS accounting interim-update crosses 80% of data_limit_mb.
 */

const cron = require('node-cron');
const { Op } = require('sequelize');
const { Customer, Package, Router, Session } = require('../models');
const radiusService = require('../services/radiusService');
const coaService    = require('../services/coaService');
const sms           = require('../services/smsService');
const logger        = require('../config/logger');
const { isMinuteBased, isDayBased } = require('../utils/duration');

const TZ = process.env.TZ || 'Africa/Nairobi';

// ── Revoke a single expired customer ─────────────────────────────────────────
// Steps: mark expired → block in RADIUS → CoA disconnect → SMS
const revokeCustomer = async (customer, summary) => {
  try {
    await customer.update({ status: 'expired' });
    summary.expired++;

    // Block in FreeRADIUS — sets Auth-Type := Reject so they can't reconnect
    await radiusService.disableUser(customer.username);
    summary.radius_blocked++;

    logger.info(`Expired: ${customer.username} (${customer.Package?.name || 'unknown package'})`);

    // CoA disconnect — kicks the live session immediately if router is online
    if (customer.Router?.status === 'online') {
      const activeSession = await Session.findOne({
        where: { username: customer.username, is_active: true },
      });
      const coa = await coaService.disconnectUser(
        customer.Router.ip_address,
        customer.username,
        activeSession?.session_id
      );
      if (coa.success) {
        summary.sessions_killed++;
      } else {
        logger.warn(`CoA failed for ${customer.username}: ${coa.message}`);
      }
    }

    // SMS — non-blocking
    if (customer.phone) {
      sms.sendAccountExpired(customer.phone, {
        fullName: customer.full_name,
        packageName: customer.Package?.name,
      }).catch(() => {});
    }
  } catch (err) {
    const msg = `Failed to revoke ${customer.username}: ${err.message}`;
    summary.errors.push(msg);
    logger.error(msg);
  }
};

// ── Job 1: Universal expiry — runs every minute ───────────────────────────────
// Catches both minute-based (hotspot timed) and day-based (monthly) customers.
const runExpiryJob = async () => {
  const summary = {
    checked: 0, expired: 0, radius_blocked: 0, sessions_killed: 0, errors: []
  };

  try {
    const expired = await Customer.findAll({
      where: {
        status: 'active',
        expiry_date: { [Op.lt]: new Date() },
      },
      include: [
        { model: Router,  attributes: ['id', 'ip_address', 'status'] },
        { model: Package, attributes: ['id', 'name', 'duration_days', 'duration_minutes'] },
      ],
    });

    summary.checked = expired.length;
    if (expired.length === 0) return summary;

    logger.info(`⏰ Expiry job: ${expired.length} expired customer(s) to process`);
    for (const c of expired) await revokeCustomer(c, summary);

    logger.info('✅ Expiry job complete', summary);
  } catch (err) {
    logger.error('Expiry job fatal error', err);
    summary.errors.push(err.message);
  }

  return summary;
};

// ── Job 2: Expiry warning — SMS day-based customers expiring in < 24hrs ───────
// Only warns day-based packages — minute-based packs are too short to warn.
// Runs at 10:00 and 18:00 daily so the customer gets a reminder at a reasonable time.
const runExpiryWarningJob = async () => {
  try {
    const now     = new Date();
    const in24hrs = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const expiringSoon = await Customer.findAll({
      where: {
        status:      'active',
        expiry_date: { [Op.between]: [now, in24hrs] },
        phone:       { [Op.not]: null },
      },
      include: [{
        model: Package,
        attributes: ['id', 'name', 'duration_days', 'duration_minutes'],
      }],
    });

    // Only warn day-based customers — minute-based ones expire in < 20hrs anyway
    const toWarn = expiringSoon.filter(c => !c.Package || isDayBased(c.Package));

    if (toWarn.length === 0) return;

    logger.info(`📱 Expiry warning: sending SMS to ${toWarn.length} customer(s)`);

    for (const customer of toWarn) {
      sms.sendExpiryWarning(customer.phone, {
        fullName:    customer.full_name,
        expiryDate:  customer.expiry_date,
        packageName: customer.Package?.name || 'your package',
      }).catch(() => {});
    }
  } catch (err) {
    logger.error('Expiry warning job error', err);
  }
};

// ── Schedule setup ────────────────────────────────────────────────────────────
const startExpiryJob = () => {
  // Expiry check — every minute (handles both minute-based and day-based)
  logger.info('⏰ Expiry job started (every minute)');
  cron.schedule('* * * * *', runExpiryJob, { timezone: TZ });

  // Expiry warning — 10:00 and 18:00 daily
  logger.info('📱 Expiry warning job scheduled: 10:00 and 18:00 daily');
  cron.schedule('0 10,18 * * *', runExpiryWarningJob, { timezone: TZ });
};

module.exports = { startExpiryJob, runExpiryJob, runExpiryWarningJob };