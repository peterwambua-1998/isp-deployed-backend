/**
 * routes/accounting.js
 *
 * RADIUS Accounting receiver.
 *
 * FreeRADIUS is configured to POST accounting packets to this endpoint
 * via the rlm_rest module. Every time something happens to a customer
 * session on MikroTik, FreeRADIUS sends us a packet.
 *
 * There are 3 packet types (Acct-Status-Type):
 *
 *   Start   — customer just connected
 *             → create a Session record, mark customer online
 *
 *   Interim-Update — customer is still connected (sent every ~5 min)
 *             → update bytes used on the Session record
 *             → check if data cap exceeded → cut them off if so
 *
 *   Stop    — customer disconnected
 *             → finalize Session record with total usage + cause
 *
 * FreeRADIUS rlm_rest config (in /etc/freeradius/3.0/mods-available/rest):
 *   accounting {
 *     uri  = "http://YOUR_SERVER/api/accounting"
 *     method = "post"
 *     body = "json"
 *   }
 *
 * ALL routes here are PUBLIC — FreeRADIUS hits them directly, no JWT.
 * Security is via the shared secret checked in the X-Radius-Secret header.
 */

const express = require('express');
const { Op } = require('sequelize');
const { Session, Customer, Package, Router } = require('../models');
const sms = require('../services/smsService');
const logger = require('../config/logger');

const router = express.Router();

// ── Middleware: verify request is genuinely from FreeRADIUS ───────────────
// FreeRADIUS sends this header — set it in rlm_rest config
const verifyRadiusSecret = (req, res, next) => {
  const secret = req.headers['x-radius-secret'];
  if (secret !== process.env.RADIUS_SHARED_SECRET) {
    logger.warn(`Accounting: rejected request with invalid secret from ${req.ip}`);
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

router.use(verifyRadiusSecret);

// ── POST /api/accounting ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // Always respond 200 fast — FreeRADIUS will retry if we don't
  res.json({ success: true });

  try {
    const attrs = req.body;
    const statusType = attrs['Acct-Status-Type'];   // 'Start' | 'Interim-Update' | 'Stop'
    const username = attrs['User-Name'];
    const sessionId = attrs['Acct-Session-Id'];
    const nasIp = attrs['NAS-IP-Address'];
    const framedIp = attrs['Framed-IP-Address'];
    const bytesIn = parseInt(attrs['Acct-Input-Octets'] || 0);
    const bytesOut = parseInt(attrs['Acct-Output-Octets'] || 0);
    const sessionTime = parseInt(attrs['Acct-Session-Time'] || 0);
    const terminateCause = attrs['Acct-Terminate-Cause'];

    if (!username || !sessionId || !statusType) {
      logger.warn('Accounting: received packet missing required fields', attrs);
      return;
    }

    logger.info(`Accounting [${statusType}] user=${username} session=${sessionId} nas=${nasIp}`);

    // Look up customer — needed for data cap checks
    const customer = await Customer.findOne({ where: { username } });

    switch (statusType) {

      // ── START ──────────────────────────────────────────────────────────────
      // Customer just authenticated and connected
      case 'Start': {
        // Close any stale open sessions for this user (e.g. after router reboot)
        await Session.update(
          { is_active: false, stopped_at: new Date(), terminate_cause: 'NAS-Reboot' },
          { where: { username, is_active: true } }
        );

        await Session.create({
          customer_id: customer?.id || null,
          username,
          session_id: sessionId,
          nas_ip: nasIp,
          framed_ip: framedIp,
          bytes_in: 0,
          bytes_out: 0,
          started_at: new Date(),
          is_active: true,
        });

        logger.info(`Accounting: Session STARTED for ${username} (IP: ${framedIp})`);
        break;
      }

      // ── INTERIM-UPDATE ─────────────────────────────────────────────────────
      // Customer is still online — FreeRADIUS sends this every ~5 minutes
      // This is where we enforce data caps in near-real-time
      case 'Interim-Update': {
        const session = await Session.findOne({ where: { session_id: sessionId, is_active: true } });

        if (session) {
          await session.update({ bytes_in: bytesIn, bytes_out: bytesOut, framed_ip: framedIp });
        } else {
          // Session wasn't caught at Start (e.g. server restarted mid-session) — create it now
          await Session.create({
            customer_id: customer?.id || null,
            username,
            session_id: sessionId,
            nas_ip: nasIp,
            framed_ip: framedIp,
            bytes_in: bytesIn,
            bytes_out: bytesOut,
            started_at: new Date(Date.now() - sessionTime * 1000),
            is_active: true,
          });
        }

        // ── Data Cap Enforcement ─────────────────────────────────────────────
        if (customer?.package_id) {
          const pkg = await Package.findByPk(customer.package_id);

          if (pkg && pkg.data_limit_mb > 0) {
            const totalMb = (bytesIn + bytesOut) / (1024 * 1024);
            const limitMb = Number(pkg.data_limit_mb);

            if (totalMb >= limitMb) {
              logger.warn(`Accounting: ${username} hit data cap (${totalMb.toFixed(1)}MB / ${limitMb}MB) — disconnecting`);

              // Disable in RADIUS — next re-auth attempt will be rejected
              const radiusService = require('../services/radiusService');
              await radiusService.disableUser(username);
              await customer.update({ status: 'suspended' });

              // Kill live session via CoA
              if (nasIp) {
                const coaService = require('../services/coaService');
                await coaService.disconnectUser(nasIp, username, session?.session_id)
                  .catch((e) => logger.warn(`CoA disconnect failed for ${username}: ${e.message}`));
              }

              // SMS customer — non-blocking
              if (customer.phone) {
                sms.sendDataExhausted(customer.phone, {
                  fullName: customer.full_name,
                  limitMb,
                }).catch(() => { });
              }
            } else {
              const pct = (totalMb / limitMb) * 100;
              if (pct >= 80) {
                logger.warn(`Accounting: ${username} at ${pct.toFixed(0)}% of data cap`);
                // Only SMS once at 80% — check if we haven't already sent it this session
                if (pct < 95 && session && !session.warned_80) {
                  await session.update({ warned_80: true });
                  if (customer.phone) {
                    sms.sendDataWarning(customer.phone, {
                      fullName: customer.full_name,
                      usedMb: Math.round(totalMb),
                      limitMb,
                      percent: Math.round(pct),
                    }).catch(() => { });
                  }
                }
              }
            }
          }
        }

        logger.info(`Accounting: Interim update for ${username} — in: ${formatBytes(bytesIn)} out: ${formatBytes(bytesOut)}`);
        break;
      }

      // ── STOP ───────────────────────────────────────────────────────────────
      // Customer disconnected — finalize the session record
      case 'Stop': {
        const session = await Session.findOne({ where: { session_id: sessionId } });

        if (session) {
          await session.update({
            bytes_in: bytesIn,
            bytes_out: bytesOut,
            stopped_at: new Date(),
            terminate_cause: terminateCause || 'User-Request',
            is_active: false,
          });
        } else {
          // Missed the Start packet — create a complete record retroactively
          await Session.create({
            customer_id: customer?.id || null,
            username,
            session_id: sessionId,
            nas_ip: nasIp,
            framed_ip: framedIp,
            bytes_in: bytesIn,
            bytes_out: bytesOut,
            started_at: new Date(Date.now() - sessionTime * 1000),
            stopped_at: new Date(),
            terminate_cause: terminateCause || 'Unknown',
            is_active: false,
          });
        }

        logger.info(
          `Accounting: Session STOPPED for ${username} — ` +
          `total: ${formatBytes(bytesIn + bytesOut)}, cause: ${terminateCause}`
        );
        break;
      }

      default:
        logger.warn(`Accounting: Unknown Acct-Status-Type: ${statusType}`);
    }
  } catch (err) {
    logger.error('Accounting: Error processing packet', err);
  }
});

// ── Bytes formatter helper ─────────────────────────────────────────────────
const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
};

module.exports = router;
