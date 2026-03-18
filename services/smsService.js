/**
 * services/smsService.js
 *
 * SMS notifications via Africa's Talking
 * https://africastalking.com — the standard for SMS in Kenya/East Africa
 *
 * Install: npm i africastalking
 *
 * Notifications sent:
 *   - Payment confirmed        → "Your payment of KES X received..."
 *   - Account activated        → "Your internet is active until..."
 *   - Expiring in 24hrs        → "Your internet expires tomorrow..."
 *   - Account expired          → "Your internet has expired. Pay to reconnect."
 *   - Account suspended        → "Your account has been suspended..."
 *   - Data cap warning (80%)   → "You have used 80% of your data..."
 *   - Data cap hit (100%)      → "You have used all your data..."
 */

const logger = require('../config/logger');
const { Admin, Mikrotik: Router } = require('../models')

// ── Lazy init — only connect when first SMS is sent ───────────────────────
let AT = null;
let smsClient = null;

const getClient = () => {
  if (smsClient) return smsClient;

  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;

  if (!apiKey || !username) {
    throw new Error('Africa\'s Talking credentials not set. Add AT_API_KEY and AT_USERNAME to .env');
  }

  if (!AT) {
    AT = require('africastalking')({ apiKey, username });
  }

  smsClient = AT.SMS;
  return smsClient;
};

// ── Core send function ─────────────────────────────────────────────────────

/**
 * Normalise phone to +2547XXXXXXXX format (AT requires + prefix)
 */
const formatPhone = (phone) => {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('2547') || digits.startsWith('2541')) return `+${digits}`;
  if (digits.startsWith('07') || digits.startsWith('01')) return `+254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) return `+254${digits}`;
  return `+${digits}`;
};

/**
 * sendSms()
 * Low-level send — all notification functions call this.
 */
const sendSms = async (phone, message) => {
  if (process.env.SMS_ENABLED !== 'true') {
    logger.info(`SMS (disabled): to=${phone} msg="${message.slice(0, 60)}..."`);
    return { success: true, skipped: true };
  }

  try {
    const client = getClient();
    const to = formatPhone(phone);
    const from = process.env.AT_SENDER_ID || undefined; // optional branded sender ID

    const result = await client.send({ to: [to], message, from });
    const recipient = result.SMSMessageData?.Recipients?.[0];

    if (recipient?.status === 'Success') {
      logger.info(`SMS sent to ${to}: "${message.slice(0, 40)}..."`);
      return { success: true, messageId: recipient.messageId, cost: recipient.cost };
    } else {
      logger.warn(`SMS failed to ${to}: ${recipient?.status}`);
      return { success: false, error: recipient?.status };
    }
  } catch (err) {
    console.log('sms err');
    console.log(err);
    
    logger.error(`SMS error for ${phone}: ${err.message}`);
    return { success: false, error: err.message };
  }
};

// ── Notification templates ─────────────────────────────────────────────────

const isp = process.env.APP_NAME || 'Your ISP';

/**
 * Payment received + account activated
 */
const sendPaymentConfirmed = (phone, { amount, receipt, expiryDate, packageName }) => {
  const expiry = new Date(expiryDate).toLocaleString('en-KE', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi',
  });
  return sendSms(phone,
    `${isp}: Payment of KES ${amount} received (${receipt}). ` +
    `Your ${packageName} package is active until ${expiry}. Thank you!`
  );
};

/**
 * Account expiring soon — sent ~24hrs before expiry
 */
const sendExpiryWarning = (phone, { fullName, expiryDate, packageName }) => {
  const expiry = new Date(expiryDate).toLocaleString('en-KE', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi',
  });
  const firstName = fullName.split(' ')[0];
  return sendSms(phone,
    `Hi ${firstName}, your ${isp} ${packageName} package expires on ${expiry}. ` +
    `Renew now to stay connected.`
  );
};

/**
 * Account has expired
 */
const sendAccountExpired = (phone, { fullName }) => {
  const firstName = fullName.split(' ')[0];
  return sendSms(phone,
    `Hi ${firstName}, your ${isp} internet has expired. ` +
    `Pay to reconnect and continue browsing.`
  );
};

/**
 * Account suspended by admin
 */
const sendAccountSuspended = (phone, { fullName }) => {
  const firstName = fullName.split(' ')[0];
  return sendSms(phone,
    `Hi ${firstName}, your ${isp} account has been suspended. ` +
    `Please contact us to resolve this.`
  );
};

/**
 * Data cap warning — sent at 80% usage
 */
const sendDataWarning = (phone, { fullName, usedMb, limitMb, percent }) => {
  const firstName = fullName.split(' ')[0];
  return sendSms(phone,
    `Hi ${firstName}, you have used ${percent}% of your ${isp} data bundle ` +
    `(${usedMb}MB of ${limitMb}MB). Upgrade your package to get more data.`
  );
};

/**
 * Data cap exhausted — sent at 100%
 */
const sendDataExhausted = (phone, { fullName, limitMb }) => {
  const firstName = fullName.split(' ')[0];
  return sendSms(phone,
    `Hi ${firstName}, you have used all ${limitMb}MB of your ${isp} data bundle. ` +
    `Your session has been paused. Pay to reconnect.`
  );
};

/**
 * send router offline
 */
const sendRouterOffline = async (router) => {
  try {
    const admin = await Admin.findOne({ where: { email: 'admin@isp.co.ke' } });
    if (!admin) return
    if (!admin.phone) return
    return sendSms(admin.phone, `Router ${router.name} is offline. Ip address: ${router.ip_address}.`)
  } catch (error) {

  }
}

module.exports = {
  sendSms,
  sendPaymentConfirmed,
  sendExpiryWarning,
  sendAccountExpired,
  sendAccountSuspended,
  sendDataWarning,
  sendDataExhausted,
  sendRouterOffline
};
