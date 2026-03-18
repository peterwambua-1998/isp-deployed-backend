/**
 * routerHealthJob.js
 *
 * Every 2 minutes: pings all provisioned routers, updates:
 *  - status (online/offline)
 *  - last_seen
 *  - cpu_usage, memory_usage, disk_usage  (shown on router detail page)
 */

const cron = require('node-cron');
const { Router } = require('../models');
const mikrotikService = require('../services/mikrotikService');
const notifications = require('../services/notificationService');
const logger = require('../config/logger');
const { sendRouterOffline } = require('../services/smsService');

const runRouterHealthJob = async () => {
  const routers = await Router.findAll({
    where: { is_provisioned: true },
  });

  if (routers.length === 0) return;

  logger.info(`🔍 Router health check: ${routers.length} router(s)`);

  await Promise.allSettled(
    routers.map(async (r) => {
      try {
        // ping() uses RouterOS API — tells us identity + connectivity
        const ping = await mikrotikService.ping(r);

        console.log('ping results', ping);

        if (ping.online) {
          // If it was offline before, fire a recovery notification
          const wasOffline = r.status === 'offline';

          let statsUpdate = { status: 'online', last_seen: new Date() };
          try {
            const stats = await mikrotikService.getResourceStats(r);
            statsUpdate.cpu_usage = stats.cpu_load;
            statsUpdate.memory_usage = stats.memory_percent;
            statsUpdate.disk_usage = stats.disk_percent;
          } catch (_) {
            // Resource stats are non-fatal — router is still online
          }
          await r.update(statsUpdate);

          if (wasOffline) {
            logger.info(`Router ${r.name} (${r.ip_address}) is back ONLINE`);
            notifications.notifyRouterOnline({ router: r }).catch(() => { });
            r.update({
              offline_notification_sent: false
            })
          }
        } else {
          if (r.status === 'offline') {
            if (r.offline_notification_sent == false) {
              await r.update({ status: 'offline' });
              logger.warn(`Router ${r.name} (${r.ip_address}) went OFFLINE`);
              notifications.notifyRouterOffline({ router: r }).catch(() => { });
              sendRouterOffline(r);
              r.update({
                offline_notification_sent: true
              })
            }
          }
        }
      } catch (err) {
        if (r.status === 'offline') {
          await r.update({ status: 'offline' });
          logger.warn(`Router ${r.name} health check failed: ${err.message}`);
          notifications.notifyRouterOffline({ router: r }).catch(() => { });
        }
      }
    })
  );
};

const HEALTH_CRON = process.env.ROUTER_HEALTH_CRON || '*/2 * * * *';
const TZ = process.env.TZ || 'Africa/Nairobi';

const startRouterHealthJob = () => {
  if (!cron.validate(HEALTH_CRON)) {
    logger.error(`Invalid ROUTER_HEALTH_CRON: "${HEALTH_CRON}"`);
    return;
  }
  logger.info(`🔍 Router health job: "${HEALTH_CRON}"`);
  cron.schedule(HEALTH_CRON, runRouterHealthJob, { timezone: TZ });
};

module.exports = { startRouterHealthJob, runRouterHealthJob };