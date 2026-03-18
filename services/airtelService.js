/**
 * services/airtelService.js
 *
 * Airtel Money Collection API — Kenya (KE / KES)
 * Docs: https://developers.airtel.africa
 *
 * Flow:
 *   1. getAccessToken()   — OAuth2 client_credentials grant
 *   2. initiatePayment()  — USSD push to customer phone
 *   3. queryStatus()      — poll until TS (success) or TF (failed)
 *   4. Webhook callback   — Airtel POSTs result to AIRTEL_CALLBACK_URL
 *
 * Transaction status codes:
 *   TS  = Transaction Successful
 *   TIP = Transaction In Progress
 *   TA  = Transaction Ambiguous
 *   TF  = Transaction Failed
 */

const axios    = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger   = require('../config/logger');
const settings = require('./settingsService');

// ── Base URL ──────────────────────────────────────────────────────────────────
const getBaseUrl = async () => {
  const env = await settings.get('airtel', 'environment', process.env.AIRTEL_ENV || 'sandbox');
  return env === 'production'
    ? 'https://openapi.airtel.africa'
    : 'https://openapiuat.airtel.africa';
};

// ── Access token (short-lived ~7200s, cache it) ───────────────────────────────
let _tokenCache = null;
let _tokenExpiry = 0;

const getAccessToken = async () => {
  // Return cached token if still valid (with 60s buffer)
  if (_tokenCache && Date.now() < _tokenExpiry - 60_000) return _tokenCache;

  const clientId     = await settings.get('airtel', 'client_id',     process.env.AIRTEL_CLIENT_ID     || '');
  const clientSecret = await settings.get('airtel', 'client_secret', process.env.AIRTEL_CLIENT_SECRET || '');

  if (!clientId || !clientSecret) {
    throw new Error('Airtel Money credentials not configured. Go to Settings → Payments → Airtel Money.');
  }

  const baseUrl = await getBaseUrl();
  const res = await axios.post(`${baseUrl}/auth/oauth2/token`, {
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'client_credentials',
  }, {
    headers: { 'Content-Type': 'application/json', Accept: '*/*' },
  });

  _tokenCache  = res.data.access_token;
  _tokenExpiry = Date.now() + (res.data.expires_in || 7200) * 1000;
  return _tokenCache;
};

// ── Initiate payment (USSD push) ──────────────────────────────────────────────
/**
 * initiatePayment(phone, amount, reference, callbackUrl)
 *
 * @param {string} phone       - Customer phone without country code e.g. '733123456'
 * @param {number} amount      - Amount in KES
 * @param {string} reference   - Order reference e.g. customer username
 * @param {string} callbackUrl - Where Airtel will POST the result
 *
 * Returns { success, transactionId, message }
 * The transactionId is used to poll status and match the callback.
 */
const initiatePayment = async (phone, amount, reference, callbackUrl = null) => {
  try {
    const token       = await getAccessToken();
    const baseUrl     = await getBaseUrl();
    const country     = await settings.get('airtel', 'country',  process.env.AIRTEL_COUNTRY  || 'KE');
    const currency    = await settings.get('airtel', 'currency', process.env.AIRTEL_CURRENCY || 'KES');
    const resolvedCb  = callbackUrl || await settings.get('airtel', 'callback_url', process.env.AIRTEL_CALLBACK_URL || '');

    // Airtel requires phone without country code — strip leading + or 254
    const cleanPhone = String(phone)
      .replace(/^\+/, '')
      .replace(/^254/, '')
      .replace(/^0/, '');

    const transactionId = uuidv4(); // unique per transaction

    const payload = {
      reference,
      subscriber: {
        country,
        currency,
        msisdn: cleanPhone,
      },
      transaction: {
        amount:   Math.ceil(amount),
        country,
        currency,
        id:       transactionId,
      },
    };

    // Add callback if provided
    if (resolvedCb) {
      payload.transaction.callbackURL = resolvedCb;  // some Airtel regions support this
    }

    const res = await axios.post(`${baseUrl}/merchant/v1/payments/`, payload, {
      headers: {
        'Content-Type':  'application/json',
        Accept:          '*/*',
        'X-Country':     country,
        'X-Currency':    currency,
        Authorization:   `Bearer ${token}`,
      },
    });

    // Airtel returns 200 with status object
    const data   = res.data;
    const status = data?.status;

    if (status?.code === '200' || status?.success === true || res.status === 200) {
      logger.info(`Airtel Money: initiated payment ${transactionId} to ${cleanPhone} for KES ${amount}`);
      return {
        success:       true,
        transactionId,
        message:       status?.message || 'Payment initiated',
      };
    }

    throw new Error(status?.message || 'Payment initiation failed');
  } catch (err) {
    const msg = err.response?.data?.status?.message || err.message || 'Airtel Money request failed';
    logger.error(`Airtel Money initiate failed: ${msg}`);
    throw new Error(msg);
  }
};

// ── Query transaction status ──────────────────────────────────────────────────
/**
 * queryStatus(transactionId)
 *
 * Returns { success, status, message }
 * status values: 'TS' | 'TIP' | 'TF' | 'TA'
 */
const queryStatus = async (transactionId) => {
  try {
    const token    = await getAccessToken();
    const baseUrl  = await getBaseUrl();
    const country  = await settings.get('airtel', 'country',  'KE');
    const currency = await settings.get('airtel', 'currency', 'KES');

    const res = await axios.get(`${baseUrl}/standard/v1/payments/${transactionId}`, {
      headers: {
        'Content-Type': 'application/json',
        Accept:         '*/*',
        'X-Country':    country,
        'X-Currency':   currency,
        Authorization:  `Bearer ${token}`,
      },
    });

    const transaction = res.data?.data?.transaction;
    const txStatus    = transaction?.status;
    const message     = transaction?.message || res.data?.status?.message || '';

    return {
      success:       res.status === 200,
      status:        txStatus, // 'TS' | 'TIP' | 'TF' | 'TA'
      message,
      airtelReceipt: transaction?.airtel_money_id || transaction?.id || null,
      raw:           res.data,
    };
  } catch (err) {
    const msg = err.response?.data?.status?.message || err.message;
    logger.error(`Airtel Money status check failed: ${msg}`);
    return { success: false, status: 'TF', message: msg };
  }
};

// ── Test connection ───────────────────────────────────────────────────────────
const testConnection = async () => {
  try {
    await getAccessToken();
    const env = await settings.get('airtel', 'environment', 'sandbox');
    return { success: true, message: `Connected to Airtel Money ${env} successfully` };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

module.exports = { initiatePayment, queryStatus, testConnection, getAccessToken };