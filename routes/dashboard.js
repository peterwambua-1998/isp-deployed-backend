/**
 * routes/dashboard.js
 *
 * Single endpoint that returns everything the frontend dashboard needs
 * in one request — avoids 10 separate API calls on page load.
 *
 * GET /api/dashboard
 * GET /api/dashboard?period=today|week|month   (revenue filter, default: month)
 */

const express = require('express');
const { Op, fn, col, literal, QueryTypes } = require('sequelize');
const { Customer, Package, Router, Payment, Session, sequelize } = require('../models');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ── Helpers ────────────────────────────────────────────────────────────────

const periodStart = (period) => {
  const now = new Date();
  switch (period) {
    case 'today': {
      const d = new Date(now); d.setHours(0, 0, 0, 0); return d;
    }
    case 'week': {
      const d = new Date(now); d.setDate(d.getDate() - 7); return d;
    }
    case 'month':
    default: {
      const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
    }
  }
};

// ── GET /api/dashboard ─────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const period = req.query.period || 'month';
    const since = periodStart(period);
    const now = new Date();

    // Run all queries in parallel
    const [
      customerCounts,
      expiringCustomers,
      revenueSummary,
      revenueByDay,
      routerSummary,
      activeSessions,
      topPackages,
      recentPayments,
    ] = await Promise.all([

      // 1. Customer counts by status
      Customer.findAll({
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),

      // 2. Customers expiring in the next 24 hours (need attention)
      Customer.findAll({
        where: {
          status: 'active',
          expiry_date: { [Op.between]: [now, new Date(now.getTime() + 24 * 60 * 60 * 1000)] },
        },
        include: [{ model: Package, attributes: ['name'] }],
        attributes: ['id', 'full_name', 'phone', 'expiry_date', 'package_id'],
        order: [['expiry_date', 'ASC']],
        limit: 10,
      }),

      // 3. Revenue totals for the period (completed payments only)
      Payment.findAll({
        where: { status: 'completed', paid_at: { [Op.gte]: since } },
        attributes: [
          'method',
          [fn('SUM', col('amount')), 'total'],
          [fn('COUNT', col('id')), 'count'],
        ],
        group: ['method'],
        raw: true,
      }),

      // 4. Revenue per day for chart — last 30 days
      sequelize.query(`
        SELECT
          DATE(paid_at)           AS day,
          SUM(amount)             AS total,
          COUNT(id)               AS transactions
        FROM Payments
        WHERE status = 'completed'
          AND paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY DATE(paid_at)
        ORDER BY day ASC
      `, { type: QueryTypes.SELECT }),

      // 5. Router status counts
      Router.findAll({
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      }),

      // 6. Active sessions right now
      Session.count({ where: { is_active: true } }),

      // 7. Top packages by active subscribers
      Package.findAll({
        attributes: [
          'id', 'name', 'price', 'type',
          [fn('COUNT', col('Customers.id')), 'subscriber_count'],
        ],
        include: [{
          model: Customer,
          attributes: [],
          where: { status: 'active' },
          required: false,
        }],
        group: ['Package.id'],
        order: [[literal('subscriber_count'), 'DESC']],
        limit: 5,
        subQuery: false,
      }),

      // 8. Recent payments (last 10)
      Payment.findAll({
        where: { status: 'completed' },
        include: [{ model: Customer, attributes: ['full_name', 'username'] }],
        order: [['paid_at', 'DESC']],
        limit: 10,
        attributes: ['id', 'amount', 'method', 'mpesa_receipt', 'paid_at', 'source'],
      }),
    ]);

    // ── Shape the response ──────────────────────────────────────────────────

    // Customer summary map
    const customers = { active: 0, suspended: 0, expired: 0, new: 0, total: 0 };
    for (const row of customerCounts) {
      customers[row.status] = Number(row.count);
      customers.total += Number(row.count);
    }

    // Revenue summary
    const revenue = { total: 0, mpesa: 0, cash: 0, bank: 0, manual: 0, transactions: 0, period };
    for (const row of revenueSummary) {
      revenue[row.method] = Number(row.total);
      revenue.total += Number(row.total);
      revenue.transactions += Number(row.count);
    }

    // Router summary
    const routers = { online: 0, offline: 0, unprovisioned: 0, total: 0 };
    for (const row of routerSummary) {
      routers[row.status] = Number(row.count);
      routers.total += Number(row.count);
    }

    return res.success({
      customers,
      revenue,
      revenue_chart: revenueByDay,
      routers,
      active_sessions: activeSessions,
      expiring_soon: expiringCustomers,
      top_packages: topPackages,
      recent_payments: recentPayments,
      generated_at: new Date(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
