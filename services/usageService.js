/**
 * services/usageService.js
 *
 * Aggregates raw Session records into human-readable usage summaries.
 * Used by the dashboard, customer profile, and usage report endpoints.
 */

const { Op, fn, col, literal } = require('sequelize');
const { Session, Customer, Package } = require('../models');
const logger = require('../config/logger');

// ── Byte formatter ─────────────────────────────────────────────────────────
const formatBytes = (bytes) => {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

// ── Duration formatter (seconds → "2h 34m") ───────────────────────────────
const formatDuration = (seconds) => {
  seconds = Number(seconds) || 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

/**
 * getCustomerUsage()
 *
 * Returns a summary of a single customer's usage for a given period.
 * Includes current active session if online.
 *
 * @param {string} customerId
 * @param {'today'|'week'|'month'|'all'} period
 */
const getCustomerUsage = async (customerId, period = 'month') => {
  const since = getPeriodStart(period);
  const where = { customer_id: customerId };
  if (since) where.started_at = { [Op.gte]: since };

  const sessions = await Session.findAll({
    where,
    order: [['started_at', 'DESC']],
  });

  const totalBytesIn = sessions.reduce((sum, s) => sum + Number(s.bytes_in), 0);
  const totalBytesOut = sessions.reduce((sum, s) => sum + Number(s.bytes_out), 0);
  const totalBytes = totalBytesIn + totalBytesOut;

  const activeSession = sessions.find((s) => s.is_active);
  const sessionCount = sessions.length;

  // Total online time in seconds
  const totalSeconds = sessions.reduce((sum, s) => {
    if (s.started_at && s.stopped_at) {
      return sum + Math.floor((new Date(s.stopped_at) - new Date(s.started_at)) / 1000);
    }
    if (s.is_active && s.started_at) {
      return sum + Math.floor((Date.now() - new Date(s.started_at)) / 1000);
    }
    return sum;
  }, 0);

  return {
    period,
    session_count: sessionCount,
    is_online: !!activeSession,
    current_session: activeSession
      ? {
        session_id: activeSession.session_id,
        started_at: activeSession.started_at,
        ip: activeSession.framed_ip,
        bytes_in: formatBytes(activeSession.bytes_in),
        bytes_out: formatBytes(activeSession.bytes_out),
      }
      : null,
    usage: {
      bytes_in_raw: totalBytesIn,
      bytes_out_raw: totalBytesOut,
      total_bytes_raw: totalBytes,
      bytes_in: formatBytes(totalBytesIn),
      bytes_out: formatBytes(totalBytesOut),
      total: formatBytes(totalBytes),
    },
    online_time: {
      seconds: totalSeconds,
      formatted: formatDuration(totalSeconds),
    },
    sessions: sessions.slice(0, 20).map((s) => ({
      id: s.id,
      session_id: s.session_id,
      ip: s.framed_ip,
      bytes_in: formatBytes(s.bytes_in),
      bytes_out: formatBytes(s.bytes_out),
      total: formatBytes(Number(s.bytes_in) + Number(s.bytes_out)),
      started_at: s.started_at,
      stopped_at: s.stopped_at,
      duration: s.started_at && s.stopped_at
        ? formatDuration(Math.floor((new Date(s.stopped_at) - new Date(s.started_at)) / 1000))
        : s.is_active ? 'Active' : 'Unknown',
      terminate_cause: s.terminate_cause,
      is_active: s.is_active,
    })),
  };
};

/**
 * getRouterUsage()
 *
 * Total data and session counts per router (NAS IP) for a period.
 * Good for understanding which router is carrying the most traffic.
 */
const getRouterUsage = async (nasIp, period = 'month') => {
  const since = getPeriodStart(period);
  const where = { nas_ip: nasIp };
  if (since) where.started_at = { [Op.gte]: since };

  const sessions = await Session.findAll({ where });

  const totalBytesIn = sessions.reduce((sum, s) => sum + Number(s.bytes_in), 0);
  const totalBytesOut = sessions.reduce((sum, s) => sum + Number(s.bytes_out), 0);
  const activeSessions = sessions.filter((s) => s.is_active).length;
  const uniqueUsers = new Set(sessions.map((s) => s.username)).size;

  return {
    nas_ip: nasIp,
    period,
    active_sessions: activeSessions,
    total_sessions: sessions.length,
    unique_users: uniqueUsers,
    usage: {
      bytes_in: formatBytes(totalBytesIn),
      bytes_out: formatBytes(totalBytesOut),
      total: formatBytes(totalBytesIn + totalBytesOut),
      bytes_in_raw: totalBytesIn,
      bytes_out_raw: totalBytesOut,
    },
  };
};

/**
 * getTopConsumers()
 *
 * Returns top N customers ranked by data usage for a given period.
 * Useful for identifying heavy users or spotting abuse.
 */
const getTopConsumers = async (period = 'month', limit = 10) => {
  const since = getPeriodStart(period);
  const where = {};
  if (since) where.started_at = { [Op.gte]: since };

  const sessions = await Session.findAll({
    where,
    include: [{ model: Customer, attributes: ['id', 'full_name', 'username', 'phone', 'status'] }],
  });

  // Aggregate per username
  const usageMap = {};
  for (const s of sessions) {
    const key = s.username;
    if (!usageMap[key]) {
      usageMap[key] = {
        username: s.username,
        customer: s.Customer
          ? { id: s.Customer.id, name: s.Customer.full_name, phone: s.Customer.phone, status: s.Customer.status }
          : null,
        bytes_in: 0,
        bytes_out: 0,
        session_count: 0,
      };
    }
    usageMap[key].bytes_in += Number(s.bytes_in);
    usageMap[key].bytes_out += Number(s.bytes_out);
    usageMap[key].session_count++;
  }

  // Sort by total bytes descending
  const sorted = Object.values(usageMap)
    .map((u) => ({
      ...u,
      total_bytes: u.bytes_in + u.bytes_out,
      bytes_in_fmt: formatBytes(u.bytes_in),
      bytes_out_fmt: formatBytes(u.bytes_out),
      total_fmt: formatBytes(u.bytes_in + u.bytes_out),
    }))
    .sort((a, b) => b.total_bytes - a.total_bytes)
    .slice(0, limit);

  return { period, top_consumers: sorted };
};

/**
 * getDailyUsage()
 *
 * Returns daily breakdown of total data usage for the last N days.
 * Used for bandwidth graphs on the dashboard.
 */
const getDailyUsage = async (days = 30, nasIp = null) => {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const where = { started_at: { [Op.gte]: since } };
  if (nasIp) where.nas_ip = nasIp;

  const sessions = await Session.findAll({ where });

  // Group by date
  const dailyMap = {};
  for (const s of sessions) {
    if (!s.started_at) continue;
    const day = new Date(s.started_at).toISOString().slice(0, 10); // YYYY-MM-DD
    if (!dailyMap[day]) {
      dailyMap[day] = { date: day, bytes_in: 0, bytes_out: 0, sessions: 0, unique_users: new Set() };
    }
    dailyMap[day].bytes_in += Number(s.bytes_in);
    dailyMap[day].bytes_out += Number(s.bytes_out);
    dailyMap[day].sessions++;
    dailyMap[day].unique_users.add(s.username);
  }

  const result = Object.values(dailyMap)
    .map((d) => ({
      date: d.date,
      bytes_in_raw: d.bytes_in,
      bytes_out_raw: d.bytes_out,
      total_raw: d.bytes_in + d.bytes_out,
      bytes_in: formatBytes(d.bytes_in),
      bytes_out: formatBytes(d.bytes_out),
      total: formatBytes(d.bytes_in + d.bytes_out),
      sessions: d.sessions,
      unique_users: d.unique_users.size,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { days, daily: result };
};

// ── Helper: get period start date ─────────────────────────────────────────
const getPeriodStart = (period) => {
  const now = new Date();
  switch (period) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case 'week':
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - 7);
      return weekStart;
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'all':
    default:
      return null;
  }
};

module.exports = { getCustomerUsage, getRouterUsage, getTopConsumers, getDailyUsage, formatBytes };
