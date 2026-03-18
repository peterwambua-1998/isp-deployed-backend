/**
 * routes/usage.js
 *
 * Usage reporting endpoints.
 * All protected — admin only, except /my which customers can call.
 */

const express = require('express');
const { Session, Customer, Router } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const usageService = require('../services/usageService');

const router = express.Router();
router.use(authenticate);

// GET /api/usage/customer/:id?period=month
// Full usage breakdown for a specific customer
router.get('/customer/:id', async (req, res, next) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const period = req.query.period || 'month';
    const usage = await usageService.getCustomerUsage(req.params.id, period);

    return res.success({ customer: { id: customer.id, name: customer.full_name, username: customer.username }, ...usage });
  } catch (err) {
    next(err);
  }
});

// GET /api/usage/router/:id?period=month
// Traffic totals for a specific MikroTik router
router.get('/router/:id', async (req, res, next) => {
  try {
    const routerDevice = await Router.findByPk(req.params.id);
    if (!routerDevice) return res.status(404).json({ success: false, message: 'Router not found' });

    const period = req.query.period || 'month';
    const usage = await usageService.getRouterUsage(routerDevice.ip_address, period);

    return res.success({ router: { id: routerDevice.id, name: routerDevice.name }, ...usage });
  } catch (err) {
    next(err);
  }
});

// GET /api/usage/top?period=month&limit=10
// Top data consumers — useful for spotting heavy users or abuse
router.get('/top', authorize('admin', 'superadmin'), async (req, res, next) => {
  try {
    const period = req.query.period || 'month';
    const limit = Math.min(parseInt(req.query.limit || 10), 50);
    const result = await usageService.getTopConsumers(period, limit);
    return res.success(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/usage/daily?days=30&router_id=UUID
// Daily bandwidth chart data — feed directly into a chart on the dashboard
router.get('/daily', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days || 30), 90);
    let nasIp = null;

    if (req.query.router_id) {
      const routerDevice = await Router.findByPk(req.query.router_id);
      if (routerDevice) nasIp = routerDevice.ip_address;
    }

    const result = await usageService.getDailyUsage(days, nasIp);
    return res.success(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/usage/live
// All currently active sessions across all routers
router.get('/live', async (req, res, next) => {
  try {
    const sessions = await Session.findAll({
      where: { is_active: true },
      include: [{ model: Customer, attributes: ['id', 'full_name', 'username', 'phone', 'package_id'] }],
      order: [['started_at', 'DESC']],
    });

    const formatted = sessions.map((s) => ({
      session_id: s.session_id,
      username: s.username,
      customer: s.Customer ? { id: s.Customer.id, name: s.Customer.full_name, phone: s.Customer.phone } : null,
      nas_ip: s.nas_ip,
      framed_ip: s.framed_ip,
      bytes_in: usageService.formatBytes(s.bytes_in),
      bytes_out: usageService.formatBytes(s.bytes_out),
      total: usageService.formatBytes(Number(s.bytes_in) + Number(s.bytes_out)),
      started_at: s.started_at,
      online_for: s.started_at
        ? formatDuration(Math.floor((Date.now() - new Date(s.started_at)) / 1000))
        : null,
    }));

    return res.success({ active_count: formatted.length, sessions: formatted });
  } catch (err) {
    next(err);
  }
});

const formatDuration = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

module.exports = router;
