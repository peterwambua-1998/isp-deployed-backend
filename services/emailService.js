/**
 * services/emailService.js
 *
 * Email delivery via Nodemailer (SMTP).
 * Works with Gmail, Zoho, SendGrid, any SMTP provider.
 *
 * Required .env vars:
 *   EMAIL_ENABLED=true
 *   EMAIL_HOST=smtp.gmail.com
 *   EMAIL_PORT=587
 *   EMAIL_SECURE=false          (true for port 465)
 *   EMAIL_USER=you@gmail.com
 *   EMAIL_PASS=your_app_password
 *   EMAIL_FROM="ISP Billing <billing@yourisp.co.ke>"
 *
 * Gmail note: Use an App Password (not your account password).
 *   Google Account → Security → 2-Step Verification → App Passwords
 */

const logger = require('../config/logger');

// ── Lazy transporter — only created when first email is sent ──────────────
let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  const host = process.env.EMAIL_HOST;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!host || !user || !pass) {
    throw new Error('Email credentials not configured. Set EMAIL_HOST, EMAIL_USER, EMAIL_PASS in .env');
  }

  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host,
    port:   Number(process.env.EMAIL_PORT)   || 587,
    secure: process.env.EMAIL_SECURE === 'true',  // true = TLS on connect (port 465)
    auth:   { user, pass },
    // Connection pooling for efficiency under load
    pool:   true,
    maxConnections: 3,
  });

  return transporter;
};

// ── Core send function ────────────────────────────────────────────────────

/**
 * sendEmail({ to, subject, html, text })
 *
 * Low-level send — all notification helpers call this.
 * Returns { success, messageId } or { success: false, error }
 */
const sendEmail = async ({ to, subject, html, text }) => {
  if (process.env.EMAIL_ENABLED !== 'true') {
    logger.info(`Email (disabled): to=${to} subject="${subject}"`);
    return { success: true, skipped: true };
  }

  try {
    const t    = getTransporter();
    const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;

    const info = await t.sendMail({ from, to, subject, html, text });
    logger.info(`Email sent to ${to}: "${subject}" (${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    logger.error(`Email error for ${to}: ${err.message}`);
    return { success: false, error: err.message };
  }
};

// ── HTML wrapper ─────────────────────────────────────────────────────────

const isp     = process.env.APP_NAME     || 'ISP Billing';
const primary = '#2563eb';

/**
 * Wraps content in a clean responsive email shell.
 */
const html = (title, bodyHtml) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:${primary};padding:24px 32px;">
            <span style="color:#ffffff;font-size:20px;font-weight:bold;">${isp}</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            ${bodyHtml}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:12px;color:#94a3b8;text-align:center;">
              This is an automated message from ${isp}. Please do not reply to this email.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

const p  = (text, style = '') => `<p style="margin:0 0 16px;color:#1e293b;font-size:15px;line-height:1.6;${style}">${text}</p>`;
const h1 = (text)             => `<h1 style="margin:0 0 20px;color:#0f172a;font-size:22px;font-weight:700;">${text}</h1>`;
const badge = (text, color = primary) =>
  `<span style="display:inline-block;background:${color};color:#fff;padding:4px 12px;border-radius:99px;font-size:13px;font-weight:600;">${text}</span>`;

// ── Notification templates ────────────────────────────────────────────────

/**
 * Payment received → customer
 */
const sendPaymentEmail = (email, { fullName, amount, receipt, packageName, expiryDate }) => {
  const firstName = fullName.split(' ')[0];
  const expiry    = new Date(expiryDate).toLocaleString('en-KE', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Nairobi',
  });

  return sendEmail({
    to:      email,
    subject: `Payment Received — KES ${amount} | ${isp}`,
    text:    `Hi ${firstName}, payment of KES ${amount} received (${receipt}). Your ${packageName} package is active until ${expiry}.`,
    html:    html('Payment Received', `
      ${h1('Payment Received ✓')}
      ${p(`Hi <strong>${firstName}</strong>, we have received your payment.`)}
      <table width="100%" cellpadding="12" cellspacing="0" style="background:#f8fafc;border-radius:8px;margin-bottom:20px;">
        <tr>
          <td style="color:#64748b;font-size:14px;">Amount</td>
          <td style="text-align:right;font-weight:700;color:#0f172a;font-size:16px;">KES ${Number(amount).toLocaleString()}</td>
        </tr>
        <tr style="border-top:1px solid #e2e8f0;">
          <td style="color:#64748b;font-size:14px;">Receipt</td>
          <td style="text-align:right;font-family:monospace;color:#0f172a;">${receipt || '—'}</td>
        </tr>
        <tr style="border-top:1px solid #e2e8f0;">
          <td style="color:#64748b;font-size:14px;">Package</td>
          <td style="text-align:right;color:#0f172a;">${packageName}</td>
        </tr>
        <tr style="border-top:1px solid #e2e8f0;">
          <td style="color:#64748b;font-size:14px;">Active Until</td>
          <td style="text-align:right;color:#0f172a;">${expiry}</td>
        </tr>
      </table>
      ${p('Thank you for choosing ' + isp + '. Enjoy your internet!')}
    `),
  });
};

/**
 * New customer welcome → customer
 */
const sendWelcomeEmail = (email, { fullName, username, packageName }) => {
  const firstName = fullName.split(' ')[0];
  return sendEmail({
    to:      email,
    subject: `Welcome to ${isp}!`,
    text:    `Hi ${firstName}, welcome to ${isp}! Your account username is ${username} and your package is ${packageName}.`,
    html:    html(`Welcome to ${isp}`, `
      ${h1(`Welcome to ${isp}! 🎉`)}
      ${p(`Hi <strong>${firstName}</strong>, your account has been set up and you're ready to connect.`)}
      <table width="100%" cellpadding="12" cellspacing="0" style="background:#f8fafc;border-radius:8px;margin-bottom:20px;">
        <tr>
          <td style="color:#64748b;font-size:14px;">Username</td>
          <td style="text-align:right;font-family:monospace;font-weight:700;color:#0f172a;">${username}</td>
        </tr>
        <tr style="border-top:1px solid #e2e8f0;">
          <td style="color:#64748b;font-size:14px;">Package</td>
          <td style="text-align:right;color:#0f172a;">${packageName}</td>
        </tr>
      </table>
      ${p('If you have any questions, please contact our support team.')}
      ${p('Welcome aboard! 🚀')}
    `),
  });
};

/**
 * Router offline alert → admin
 */
const sendRouterOfflineEmail = (email, { routerName, routerIp, detectedAt }) => {
  const time = new Date(detectedAt).toLocaleString('en-KE', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi',
  });
  return sendEmail({
    to:      email,
    subject: `⚠️ Router Offline: ${routerName} | ${isp}`,
    text:    `Router ${routerName} (${routerIp}) went offline at ${time}. Please investigate.`,
    html:    html('Router Offline Alert', `
      ${h1('⚠️ Router Offline')}
      ${p('A router on your network has gone offline and requires attention.')}
      <table width="100%" cellpadding="12" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;margin-bottom:20px;">
        <tr>
          <td style="color:#64748b;font-size:14px;">Router</td>
          <td style="text-align:right;font-weight:700;color:#0f172a;">${routerName}</td>
        </tr>
        <tr style="border-top:1px solid #fecaca;">
          <td style="color:#64748b;font-size:14px;">IP Address</td>
          <td style="text-align:right;font-family:monospace;color:#0f172a;">${routerIp}</td>
        </tr>
        <tr style="border-top:1px solid #fecaca;">
          <td style="color:#64748b;font-size:14px;">Detected At</td>
          <td style="text-align:right;color:#0f172a;">${time}</td>
        </tr>
      </table>
      ${p('Please check the router and restore connectivity as soon as possible.', 'color:#dc2626;')}
    `),
  });
};

module.exports = {
  sendEmail,
  sendPaymentEmail,
  sendWelcomeEmail,
  sendRouterOfflineEmail,
};