/**
 * routes/hotspot.js
 *
 * Captive Portal API — ALL routes here are PUBLIC (no JWT auth).
 * These endpoints are hit by the customer's device directly through
 * the hotspot network, before they are authenticated.
 *
 * Flow:
 *  1. Customer connects to WiFi
 *  2. MikroTik redirects them to captive portal with ?mac=&ip=&router=
 *  3. GET  /api/hotspot/init        → save MAC+IP, return available packages
 *  4. POST /api/hotspot/pay         → initiate M-Pesa STK push
 *  5. GET  /api/hotspot/status/:id  → poll payment status (frontend polls this)
 *  6. [M-Pesa callback fires]       → auto-login via MikroTik API
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const { HotspotSession, Package, Customer, Payment, Router } = require('../models');
const mpesaService = require('../services/mpesaService');
const logger = require('../config/logger');

const router = express.Router();
const { handleMpesaCallback } = require('./payments');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — GET /api/hotspot/init?mac=XX:XX:XX&ip=192.168.88.50&router_id=UUID
//
// Called when customer lands on the captive portal page.
// Saves their MAC + IP so we can auto-login them after payment.
// Returns available packages for this router.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/init', async (req, res, next) => {
  try {
    const { mac, ip, router_id } = req.query;

    if (!mac || !ip || !router_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing mac, ip, or router_id query parameters',
      });
    }

    // Validate router exists
    const routerDevice = await Router.findByPk(router_id);
    if (!routerDevice) {
      return res.status(404).json({ success: false, message: 'Router not found' });
    }

    // Upsert a HotspotSession for this device (one per MAC)
    // If they refresh the page, we update their IP (it may change)
    let session = await HotspotSession.findOne({
      where: {
        mac,
        router_id,
        status: { [Op.in]: ['pending', 'paid'] },
        expires_at: { [Op.gt]: new Date() },
      },
    });

    if (!session) {
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 30); // 30-min window to complete payment

      session = await HotspotSession.create({
        mac,
        ip,
        router_id,
        expires_at: expiresAt,
        status: 'pending',
      });
    } else {
      // Refresh IP in case it changed
      await session.update({ ip });
    }

    // Fetch packages available for hotspot
    const packages = await Package.findAll({
      where: { type: 'hotspot', is_active: true },
      order: [['price', 'ASC']],
      attributes: ['id', 'name', 'price', 'duration_days', 'duration_minutes', 'speed_download', 'speed_upload', 'data_limit_mb'],
    });

    return res.json({
      success: true,
      session_id: session.id,
      packages,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — POST /api/hotspot/pay
//
// Customer picks a package and enters their phone number.
// We create/find their customer record, then fire M-Pesa STK push.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/pay',
  [
    body('session_id').isUUID().withMessage('Invalid session'),
    body('package_id').isUUID().withMessage('Select a package'),
    body('phone')
      .matches(/^(?:254|\+254|0)(7\d{8}|1\d{8})$/)
      .withMessage('Enter a valid Kenyan phone number'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { session_id, package_id, phone: rawPhone } = req.body;

      // Normalize phone to 2547XXXXXXXX format
      const phone = normalizePhone(rawPhone);

      // Validate hotspot session
      const session = await HotspotSession.findOne({
        where: {
          id: session_id,
          status: 'pending',
          expires_at: { [Op.gt]: new Date() },
        },
      });
      if (!session) {
        return res.status(400).json({
          success: false,
          message: 'Session expired or not found. Please refresh and try again.',
        });
      }

      const pkg = await Package.findOne({ where: { id: package_id, is_active: true } });
      if (!pkg) {
        return res.status(404).json({ success: false, message: 'Package not found' });
      }

      // Find or auto-create a customer record based on phone number
      // For hotspot walk-in customers we auto-generate a username from their MAC
      let customer = await Customer.findOne({ where: { phone } });
      if (!customer) {
        const username = `hs_${session.mac.replace(/:/g, '').toLowerCase()}`;
        const password = Math.random().toString(36).slice(-8); // random 8-char password

        customer = await Customer.create({
          full_name: `Hotspot User`,
          phone,
          username,
          password,
          service_type: 'hotspot',
          status: 'new',
          router_id: session.router_id,
          package_id: pkg.id,
        });

        logger.info(`Hotspot: Auto-created customer ${username} for MAC ${session.mac}`);
      }

      // Create a pending Payment record
      const payment = await Payment.create({
        customer_id: customer.id,
        package_id: pkg.id,
        amount: pkg.price,
        method: 'mpesa',
        status: 'pending',
        source: 'hotspot',   // ← tells the single callback to auto-login after payment
        phone,
      });

      // Fire M-Pesa STK push — use the hotspot-specific callback URL
      // so Safaricom posts back to /api/hotspot/mpesa/callback (not the admin payments callback)
      const hotspotCallbackUrl = process.env.MPESA_HOTSPOT_CALLBACK_URL
        || `${process.env.PROVISION_BASE_URL?.replace('/provision', '')}/api/hotspot/mpesa/callback`;

      const mpesaRes = await mpesaService.stkPush(
        phone,
        pkg.price,
        customer.username,
        `WiFi - ${pkg.name}`,
        hotspotCallbackUrl
      );

      // Link checkout ID back to payment and hotspot session
      await payment.update({ mpesa_checkout_id: mpesaRes.CheckoutRequestID });
      await session.update({
        customer_id: customer.id,
        package_id: pkg.id,
        phone,
        checkout_id: mpesaRes.CheckoutRequestID,
        status: 'pending',
      });

      logger.info(`Hotspot: STK Push sent to ${phone} for package "${pkg.name}" (${pkg.price} KES)`);

      return res.json({
        success: true,
        message: 'Check your phone and enter M-Pesa PIN to complete payment.',
        payment_id: payment.id,
        checkout_request_id: mpesaRes.CheckoutRequestID,
        amount: pkg.price,
        package: pkg.name,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — GET /api/hotspot/status/:checkout_id
//
// Frontend polls this every 3 seconds after STK push to check if paid.
// Returns { status: 'pending' | 'paid' | 'failed' }
// When 'paid', frontend can redirect to success page — they're already online.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/:checkout_id', async (req, res, next) => {
  try {
    const payment = await Payment.findOne({
      where: { mpesa_checkout_id: req.params.checkout_id },
      include: [{ model: Package, attributes: ['name', 'duration_days', 'duration_minutes'] }],
    });

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    return res.json({
      success: true,
      status: payment.status,               // 'pending' | 'completed' | 'failed'
      receipt: payment.mpesa_receipt,
      package: payment.Package?.name,
      expires_in_days: payment.Package?.duration_days,
      expires_in_minutes: payment.Package?.duration_minutes,
      paid_at: payment.paid_at,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper — normalize Kenyan phone numbers to 2547XXXXXXXX
// ─────────────────────────────────────────────────────────────────────────────
const normalizePhone = (phone) => {
  const cleaned = phone.replace(/\s+/g, '').replace(/^\+/, '');
  if (cleaned.startsWith('0')) return '254' + cleaned.slice(1);
  if (cleaned.startsWith('254')) return cleaned;
  return '254' + cleaned;
};

// ─────────────────────────────────────────────────────────────────────────────
// M-Pesa callback — POST /api/hotspot/mpesa/callback
//
// Safaricom posts payment results here (configured via MPESA_HOTSPOT_CALLBACK_URL).
// Delegates entirely to the payments route handler via a shared helper so there
// is ONE place that handles the activate + RADIUS + auto-login logic.
//
// NOTE: This route MUST stay public (no auth). Safaricom does not send a JWT.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/mpesa/callback', async (req, res) => {
  try {
    await handleMpesaCallback(req.body);
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    logger.error('Hotspot M-Pesa callback error:', err);
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // always 200 to Safaricom
  }
});

module.exports = router;



