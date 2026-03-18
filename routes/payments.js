/**
 * routes/payments.js
 *
 * Single source of truth for all M-Pesa payments.
 *
 * ONE callback URL for Safaricom: POST /api/payments/mpesa/callback
 *
 * The Payment record has a `source` field ('admin' | 'hotspot') that tells
 * the callback what to do after payment is confirmed:
 *
 *   source = 'admin'   → update RADIUS, set expiry (standard renewal)
 *   source = 'hotspot' → update RADIUS + auto-login via MikroTik API
 *
 * This way one Daraja app, one callback URL, zero duplication.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { Payment, Customer, Package, HotspotSession, Router, Invoice } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const mpesaService    = require('../services/mpesaService');
const airtelService   = require('../services/airtelService');
const settingsService = require('../services/settingsService');
const radiusService   = require('../services/radiusService');
const mikrotikService = require('../services/mikrotikService');
const sms             = require('../services/smsService');
const logger          = require('../config/logger');
const { calcExpiry }       = require('../utils/duration');
const { createInvoice }    = require('../services/invoiceService');
const notifications        = require('../services/notificationService');

// ── Helper: get active payment provider ──────────────────────────────────────
const getActiveProvider = () => settingsService.get('payment', 'active_provider', 'mpesa');

const router = express.Router();

// ── Shared helper: activate customer in DB + RADIUS + Invoice + Notifications ─
const activateCustomer = async (customer, pkg, receipt = null, payment = null) => {
  const expiry = calcExpiry(pkg);
  await customer.update({ status: 'active', expiry_date: expiry, package_id: pkg.id });
  await radiusService.createUser(customer, pkg);
  logger.info(`Activated: ${customer.username} → expires ${expiry}`);

  // Auto-generate invoice — non-blocking
  if (payment) {
    createInvoice(payment, customer, pkg).catch(err =>
      logger.warn(`Invoice creation failed for payment ${payment.id}: ${err.message}`)
    );
  }

  // Notifications (SMS + Email to customer, in-app bell for admin) — non-blocking
  if (payment) {
    // Refresh customer to get latest expiry_date after update
    const freshCustomer = await customer.reload();
    const freshPayment  = payment.mpesa_receipt !== undefined
      ? payment
      : { ...payment, mpesa_receipt: receipt };

    notifications.notifyPaymentReceived({
      customer: freshCustomer,
      payment:  freshPayment,
      pkg,
    }).catch(err => logger.warn(`Payment notification failed: ${err.message}`));
  }

  return expiry;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/mpesa/callback  — ONE callback for ALL M-Pesa payments
// PUBLIC — Safaricom hits this. Set this single URL in your Daraja dashboard.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/mpesa/callback', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return;

    const checkoutId = callback.CheckoutRequestID;
    const resultCode = callback.ResultCode;

    logger.info(`M-Pesa callback: checkout=${checkoutId} result=${resultCode}`);

    const payment = await Payment.findOne({ where: { mpesa_checkout_id: checkoutId } });
    if (!payment) {
      logger.warn(`Callback: no payment record found for checkout ${checkoutId}`);
      return;
    }

    // ── Payment failed or cancelled ───────────────────────────────────────────
    if (resultCode !== 0) {
      await payment.update({ status: 'failed' });
      if (payment.source === 'hotspot') {
        await HotspotSession.update(
          { status: 'expired' },
          { where: { checkout_id: checkoutId } }
        );
      }
      logger.warn(`Payment failed for ${checkoutId}: ${callback.ResultDesc}`);
      return;
    }

    // ── Payment confirmed ─────────────────────────────────────────────────────
    const items   = callback.CallbackMetadata?.Item || [];
    const get     = (name) => items.find((i) => i.Name === name)?.Value;
    const receipt = get('MpesaReceiptNumber');

    await payment.update({ status: 'completed', mpesa_receipt: receipt, paid_at: new Date() });

    const customer = await Customer.findByPk(payment.customer_id);
    const pkg      = await Package.findByPk(payment.package_id);

    if (!customer || !pkg) {
      logger.error(`Callback: missing customer or package for payment ${payment.id}`);
      return;
    }

    // Activate in DB + RADIUS + send SMS
    await activateCustomer(customer, pkg, receipt, payment);

    // ── Hotspot-specific: auto-login on MikroTik ──────────────────────────────
    if (payment.source === 'hotspot') {
      const hotspotSession = await HotspotSession.findOne({
        where: { checkout_id: checkoutId },
        include: [{ model: Router }],
      });

      if (hotspotSession?.Router) {
        const loginResult = await mikrotikService.hotspotLogin(hotspotSession.Router, {
          username: customer.username,
          password: customer.password,
          ip:       hotspotSession.ip,
          mac:      hotspotSession.mac,
        });

        if (loginResult.success) {
          await hotspotSession.update({ status: 'logged_in' });
          logger.info(`Hotspot: auto-logged in ${customer.username} on ${hotspotSession.Router.ip_address}`);
        } else {
          await hotspotSession.update({ status: 'paid' });
          logger.warn(`Hotspot: auto-login failed for ${customer.username}: ${loginResult.error}`);
        }
      } else {
        if (hotspotSession) await hotspotSession.update({ status: 'paid' });
        logger.warn(`Hotspot: no router found for checkout ${checkoutId} — RADIUS set, manual login required`);
      }
    }
  } catch (err) {
    logger.error('M-Pesa callback error', err);
  }
});

// ── Protected routes below ─────────────────────────────────────────────────
router.use(authenticate);

// POST /api/payments/initiate  — admin initiates payment for a customer
// Uses active payment provider (mpesa or airtel)
router.post(
  '/initiate',
  [
    body('customer_id').isUUID(),
    body('package_id').isUUID(),
    body('phone').notEmpty().withMessage('Phone is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { customer_id, package_id, phone } = req.body;
      const customer = await Customer.findByPk(customer_id);
      const pkg      = await Package.findByPk(package_id);

      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
      if (!pkg)      return res.status(404).json({ success: false, message: 'Package not found' });

      const provider = await getActiveProvider();

      const payment = await Payment.create({
        customer_id, package_id, phone,
        amount: pkg.price,
        method: provider,
        status: 'pending',
        source: 'admin',
      });

      if (provider === 'airtel') {
        const callbackUrl = await settingsService.get('airtel', 'callback_url', process.env.AIRTEL_CALLBACK_URL || '');
        const result = await airtelService.initiatePayment(
          phone, pkg.price, customer.username, callbackUrl
        );
        await payment.update({ mpesa_checkout_id: result.transactionId }); // reuse field for airtel tx id
        return res.success(
          { payment_id: payment.id, transaction_id: result.transactionId },
          'Airtel Money prompt sent. Customer should enter their PIN.'
        );
      } else {
        // Default: M-Pesa
        const cbUrl = await settingsService.get('mpesa', 'callback_url', process.env.MPESA_CALLBACK_URL || '');
        const mpesaRes = await mpesaService.stkPush(phone, pkg.price, customer.username, `Internet - ${pkg.name}`, cbUrl);
        await payment.update({ mpesa_checkout_id: mpesaRes.CheckoutRequestID });
        return res.success(
          { payment_id: payment.id, checkout_request_id: mpesaRes.CheckoutRequestID },
          'M-Pesa STK Push sent. Awaiting customer confirmation.'
        );
      }
    } catch (err) {
      next(err);
    }
  }
);

// Keep old route as alias for backward compatibility
router.post('/mpesa/initiate', async (req, res, next) => {
  req.url = '/initiate';
  router.handle(req, res, next);
});

// POST /api/payments/manual  — cash/bank payment recorded by admin
router.post(
  '/manual',
  authorize('admin', 'superadmin'),
  [
    body('customer_id').isUUID(),
    body('package_id').isUUID(),
    body('amount').isFloat({ min: 1 }),
    body('method').isIn(['cash', 'bank', 'manual']),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

      const { customer_id, package_id, amount, method, notes } = req.body;
      const customer = await Customer.findByPk(customer_id);
      const pkg      = await Package.findByPk(package_id);

      if (!customer || !pkg) return res.status(404).json({ success: false, message: 'Customer or package not found' });

      const payment = await Payment.create({
        customer_id, package_id, amount, method, notes,
        source: 'admin',
        status: 'completed',
        paid_at: new Date(),
      });

      await activateCustomer(customer, pkg, null, payment);

      return res.success(payment, 'Payment recorded and customer activated', 201);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/payments
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, source, customer_id } = req.query;
    const where = {};
    if (status)      where.status = status;
    if (source)      where.source = source;
    if (customer_id) where.customer_id = customer_id;

    const { count, rows } = await Payment.findAndCountAll({
      where,
      include: [
        { model: Customer, attributes: ['id', 'full_name', 'username', 'phone'] },
        { model: Package,  attributes: ['id', 'name', 'price'] },
        { model: Invoice,  attributes: ['id', 'invoice_number', 'status'] },
      ],
      limit: Number(limit),
      offset: (page - 1) * limit,
      order: [['created_at', 'DESC']],
    });

    return res.paginated(rows, count, page, limit);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/payments/airtel/callback ────────────────────────────────────────
// Airtel Money posts payment result here.
// PUBLIC — no auth, Airtel calls this directly.
// Body: { transaction: { id, status, message, airtel_money_id } }
router.post('/airtel/callback', async (req, res) => {
  try {
    res.json({ success: true }); // Acknowledge immediately

    const tx     = req.body?.transaction || req.body?.data?.transaction || req.body;
    const txId   = tx?.id;
    const status = tx?.status; // 'TS' | 'TF' | 'TA' | 'TIP'

    logger.info(`Airtel callback: txId=${txId} status=${status}`);

    if (!txId) return;

    // Find the payment — we stored the Airtel txId in mpesa_checkout_id
    const payment = await Payment.findOne({ where: { mpesa_checkout_id: txId } });
    if (!payment) {
      logger.warn(`Airtel callback: no payment for txId=${txId}`);
      return;
    }

    if (status !== 'TS') {
      await payment.update({ status: 'failed' });
      logger.warn(`Airtel payment failed: txId=${txId} status=${status}`);
      return;
    }

    // Success
    const airtelReceipt = tx?.airtel_money_id || txId;
    await payment.update({
      status:         'completed',
      mpesa_receipt:  airtelReceipt, // reuse field
      paid_at:        new Date(),
    });

    const customer = await Customer.findByPk(payment.customer_id);
    const pkg      = await Package.findByPk(payment.package_id);
    if (!customer || !pkg) return;

    await activateCustomer(customer, pkg, airtelReceipt, payment);
    logger.info(`Airtel payment completed: ${airtelReceipt} for ${customer.username}`);

  } catch (err) {
    logger.error('Airtel callback error', err);
  }
});

// ── GET /api/payments/airtel/status/:txId ─────────────────────────────────────
// Poll Airtel transaction status (for admin UI polling while waiting)
router.get('/airtel/status/:txId', authenticate, async (req, res, next) => {
  try {
    const result = await airtelService.queryStatus(req.params.txId);

    // If completed, update the payment record
    if (result.status === 'TS') {
      const payment = await Payment.findOne({ where: { mpesa_checkout_id: req.params.txId } });
      if (payment && payment.status === 'pending') {
        const airtelReceipt = result.airtelReceipt || req.params.txId;
        await payment.update({ status: 'completed', mpesa_receipt: airtelReceipt, paid_at: new Date() });
        const customer = await Customer.findByPk(payment.customer_id);
        const pkg      = await Package.findByPk(payment.package_id);
        if (customer && pkg) await activateCustomer(customer, pkg, airtelReceipt, payment);
      }
    }

    return res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// handleMpesaCallback — extracted so hotspot.js can import it
// Both /api/payments/mpesa/callback and /api/hotspot/mpesa/callback call this.
// ─────────────────────────────────────────────────────────────────────────────
const handleMpesaCallback = async (body) => {
  const callback = body?.Body?.stkCallback;
  if (!callback) return;

  const checkoutId = callback.CheckoutRequestID;
  const resultCode = callback.ResultCode;

  logger.info(`M-Pesa callback: checkout=${checkoutId} result=${resultCode}`);

  const payment = await Payment.findOne({ where: { mpesa_checkout_id: checkoutId } });
  if (!payment) {
    logger.warn(`Callback: no payment record for checkout ${checkoutId}`);
    return;
  }

  if (resultCode !== 0) {
    await payment.update({ status: 'failed' });
    if (payment.source === 'hotspot') {
      await HotspotSession.update({ status: 'expired' }, { where: { checkout_id: checkoutId } });
    }
    logger.warn(`Payment failed for ${checkoutId}: ${callback.ResultDesc}`);
    return;
  }

  const items   = callback.CallbackMetadata?.Item || [];
  const get     = (name) => items.find(i => i.Name === name)?.Value;
  const receipt = get('MpesaReceiptNumber');

  await payment.update({ status: 'completed', mpesa_receipt: receipt, paid_at: new Date() });

  const customer = await Customer.findByPk(payment.customer_id);
  const pkg      = await Package.findByPk(payment.package_id);
  if (!customer || !pkg) {
    logger.error(`Callback: missing customer or package for payment ${payment.id}`);
    return;
  }

  await activateCustomer(customer, pkg, receipt, payment);

  if (payment.source === 'hotspot') {
    const hotspotSession = await HotspotSession.findOne({
      where: { checkout_id: checkoutId },
      include: [{ model: Router }],
    });

    if (hotspotSession?.Router) {
      const loginResult = await mikrotikService.hotspotLogin(hotspotSession.Router, {
        username: customer.username,
        password: customer.password,
        ip:       hotspotSession.ip,
        mac:      hotspotSession.mac,
      });
      if (loginResult.success) {
        await hotspotSession.update({ status: 'logged_in' });
        logger.info(`Hotspot: auto-logged in ${customer.username}`);
      } else {
        await hotspotSession.update({ status: 'paid' });
        logger.warn(`Hotspot: auto-login failed for ${customer.username}: ${loginResult.error}`);
      }
    } else {
      if (hotspotSession) await hotspotSession.update({ status: 'paid' });
    }
  }
};

module.exports = { router, handleMpesaCallback };