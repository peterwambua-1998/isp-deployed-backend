require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { sequelize } = require('./models');
const logger = require('./config/logger');
const { errorHandler, notFound, responseHelper } = require('./middleware/errorHandler');

// Routes
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const packageRoutes = require('./routes/packages');
const routerRoutes = require('./routes/routers');
const provisionRoutes = require('./routes/provision');   // ← separate public file
const invoiceRoutes = require('./routes/invoices');
const notificationRoutes = require('./routes/notifications');
const settingsRoutes     = require('./routes/settings');
const paymentRoutes = require('./routes/payments').router;
const jobRoutes = require('./routes/jobs');
const hotspotRoutes = require('./routes/hotspot');
const accountingRoutes = require('./routes/accounting');
const usageRoutes = require('./routes/usage');
const dashboardRoutes = require('./routes/dashboard');
const expressListEndpoints = require("express-list-endpoints");
// Jobs
const { startExpiryJob } = require('./jobs/expiryJob');
const { startRouterHealthJob } = require('./jobs/routerHealthJob');

const app = express();

// ── Security & Middleware ──────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: (m) => logger.info(m.trim()) } }));
app.use(responseHelper);

// Rate limiters
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const hotspotLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const provisionLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);


// ── Static files (hotspot portal) ─────────────────────────────────────────
// Serves /public/hotspot.html at GET /hotspot
// MikroTik walled-garden redirects customers to:
//   http(s)://yourdomain.com/hotspot?mac=$(mac)&ip=$(ip)&router_id=<uuid>
app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.get('/hotspot', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'hotspot.html'))
);

// ── PUBLIC: Provision endpoints (MikroTik calls these — no JWT auth) ───────
// Mounted at /provision so MikroTik hits:
//   GET  https://yourdomain.com/provision/:token          → returns .rsc script
//   POST https://yourdomain.com/provision/:token/callback → receives IP back
// These are in a dedicated file (routes/provision.js) with NO authenticate middleware
app.use('/provision', provisionRoutes);

// ── API Routes (all protected by authenticate middleware inside each file) ──
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/routers', routerRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/settings',       settingsRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Hotspot portal — public, for customer devices hitting captive portal
app.use('/api/hotspot', hotspotLimiter, hotspotRoutes);

// RADIUS Accounting — FreeRADIUS posts here (secured by X-Radius-Secret header)
app.use('/api/accounting', accountingRoutes);

// Health check
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', app: process.env.APP_NAME, time: new Date() })
);

// ── Error Handling ─────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);


// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.APP_PORT || 3000;

const start = async () => {
  try {
    await sequelize.authenticate();
    logger.info('MySQL connection established');
    await sequelize.sync({ alter: true });
    logger.info('Database synced');

  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
};

start();

const endpoints = expressListEndpoints(app);

module.exports = app;