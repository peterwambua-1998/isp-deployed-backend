/**
 * mpesaService.js
 * Safaricom Daraja API — STK Push (Lipa na M-Pesa Online)
 */
const axios = require('axios');
const logger = require('../config/logger');
const settings = require('./settingsService');


const getBaseUrl = async () => {
  const env = await settings.get(
    'mpesa',
    'environment',
    process.env.MPESA_ENV || 'sandbox'
  )

  return env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

const BASE_URL =
  process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

/**
 * Get OAuth access token from Daraja
 */
const getAccessToken = async () => {
  const key = await settings.get('mpesa', 'consumer_key', process.env.MPESA_CONSUMER_KEY || '');
  const secret = await settings.get('mpesa', 'consumer_secret', process.env.MPESA_CONSUMER_SECRET || '');
  if (!key || !secret) throw new Error('M-Pesa consumer key/secret not configured. Go to Settings → M-Pesa.');
  const baseUrl = await getBaseUrl();
  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  return res.data.access_token;
};

/**
 * Generate the base64 password for STK push
 */
const getPassword = async () => {
  const shortcode = await settings.get('mpesa', 'shortcode', process.env.MPESA_SHORTCODE || '');
  const passkey   = await settings.get('mpesa', 'passkey',   process.env.MPESA_PASSKEY   || '');
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return { password: Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64'), timestamp, shortcode };
};

/**
 * Initiate STK Push to customer's phone
 * @param {string} phone        - format: 2547XXXXXXXX
 * @param {number} amount       - KES
 * @param {string} accountRef   - e.g. customer username
 * @param {string} description  - e.g. "Internet Payment"
 * @param {string} callbackUrl  - which endpoint Safaricom posts the result to
 *                                defaults to MPESA_CALLBACK_URL (admin/PPPoE payments)
 *                                pass MPESA_HOTSPOT_CALLBACK_URL for hotspot flow
 */
const stkPush = async (phone, amount, accountRef, description = 'Internet Payment', callbackUrl = null) => {
  try {
    const token = await getAccessToken();
    const { password, timestamp, shortcode } = await getPassword();
    const baseUrl = await getBaseUrl();
    const resolvedCallback = callbackUrl || await settings.get('mpesa', 'callback_url', process.env.MPESA_CALLBACK_URL);
    if (!resolvedCallback) throw new Error('M-Pesa callback URL not configured. Go to Settings → M-Pesa.');
    const res = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      BusinessShortCode: shortcode, 
      Password: password, 
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline', 
      Amount: Math.ceil(amount),
      PartyA: phone, 
      PartyB: shortcode, 
      PhoneNumber: phone,
      CallBackURL: resolvedCallback, 
      AccountReference: accountRef, 
      TransactionDesc: description,
    }, { headers: { Authorization: `Bearer ${token}` } });
    logger.info(`M-Pesa STK Push sent to ${phone}`, { checkoutId: res.data.CheckoutRequestID });
    return res.data;
  } catch (err) {
    logger.error('M-Pesa STK Push failed', err.response?.data || err.message);
    throw new Error(err.response?.data?.errorMessage || 'M-Pesa request failed');
  }
};

/**
 * Query STK push transaction status
 */
const queryStatus = async (checkoutRequestId) => {
  const token = await getAccessToken();
  const { password, timestamp, shortcode } = await getPassword();
  const baseUrl = await getBaseUrl();
  const res = await axios.post(`${baseUrl}/mpesa/stkpushquery/v1/query`, {
    BusinessShortCode: shortcode, Password: password, Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId,
  }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
};

const testConnection = async () => {
  try {
    await getAccessToken();
    const env = await settings.get('mpesa', 'environment', 'sandbox');
    return { success: true, message: `Connected to M-Pesa ${env} successfully` };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

module.exports = { stkPush, queryStatus, testConnection };
