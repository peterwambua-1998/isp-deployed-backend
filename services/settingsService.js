/**
 * services/settingsService.js
 *
 * Reads and writes admin-configurable settings from the DB.
 * Settings override .env values — DB takes priority.
 *
 * Usage:
 *   const { get, getCategory, set } = require('./settingsService');
 *   const key = await get('mpesa', 'consumer_key');
 *   const all = await getCategory('mpesa');
 *   await set('mpesa', 'consumer_key', 'abc123');
 */

const { Setting } = require('../models');
const logger = require('../config/logger');

// ── Default settings per category ─────────────────────────────────────────────
// These seed the DB on first run if no settings exist.
// Values default to current .env values so existing setups keep working.

const MPESA_DEFAULTS = [
  { key: 'consumer_key',        label: 'Consumer Key',          is_secret: true,  value: process.env.MPESA_CONSUMER_KEY    || '' },
  { key: 'consumer_secret',     label: 'Consumer Secret',       is_secret: true,  value: process.env.MPESA_CONSUMER_SECRET || '' },
  { key: 'shortcode',           label: 'Business Short Code',   is_secret: false, value: process.env.MPESA_SHORTCODE       || '' },
  { key: 'passkey',             label: 'Lipa na M-Pesa Passkey',is_secret: true,  value: process.env.MPESA_PASSKEY         || '' },
  { key: 'callback_url',        label: 'Callback URL',          is_secret: false, value: process.env.MPESA_CALLBACK_URL    || '' },
  { key: 'hotspot_callback_url',label: 'Hotspot Callback URL',  is_secret: false, value: process.env.MPESA_HOTSPOT_CALLBACK_URL || '' },
  { key: 'environment',         label: 'Environment',           is_secret: false, value: process.env.MPESA_ENV             || 'sandbox' },
  { key: 'enabled',             label: 'Enabled',               is_secret: false, value: 'true' },
];

// Default duration options — stored as JSON string
const DEFAULT_DURATIONS = JSON.stringify([
  { label: '15 Minutes',  days: 0, minutes: 15  },
  { label: '30 Minutes',  days: 0, minutes: 30  },
  { label: '1 Hour',      days: 0, minutes: 60  },
  { label: '2 Hours',     days: 0, minutes: 120 },
  { label: '3 Hours',     days: 0, minutes: 180 },
  { label: '6 Hours',     days: 0, minutes: 360 },
  { label: '12 Hours',    days: 0, minutes: 720 },
  { label: '1 Day',       days: 1, minutes: 0   },
  { label: '3 Days',      days: 3, minutes: 0   },
  { label: '7 Days',      days: 7, minutes: 0   },
  { label: '14 Days',     days: 14, minutes: 0  },
  { label: '1 Month',     days: 30, minutes: 0  },
  { label: '3 Months',    days: 90, minutes: 0  },
  { label: '6 Months',    days: 180, minutes: 0 },
  { label: '1 Year',      days: 365, minutes: 0 },
]);

const PACKAGES_DEFAULTS = [
  { key: 'duration_options', label: 'Duration Options', is_secret: false, value: DEFAULT_DURATIONS },
  { key: 'speed_presets',    label: 'Speed Presets',    is_secret: false, value: JSON.stringify([
    { label: '512 Kbps',  download: 512,   upload: 256   },
    { label: '1 Mbps',    download: 1024,  upload: 512   },
    { label: '2 Mbps',    download: 2048,  upload: 1024  },
    { label: '3 Mbps',    download: 3072,  upload: 1536  },
    { label: '5 Mbps',    download: 5120,  upload: 2048  },
    { label: '10 Mbps',   download: 10240, upload: 5120  },
    { label: '20 Mbps',   download: 20480, upload: 10240 },
    { label: '50 Mbps',   download: 51200, upload: 25600 },
  ])},
];

const SMS_DEFAULTS = [
  { key: 'enabled',     label: 'SMS Enabled',      is_secret: false, value: process.env.SMS_ENABLED  || 'false' },
  { key: 'username',    label: 'AT Username',       is_secret: false, value: process.env.AT_USERNAME  || 'sandbox' },
  { key: 'api_key',     label: 'API Key',           is_secret: true,  value: process.env.AT_API_KEY   || '' },
  { key: 'sender_id',   label: 'Sender ID',         is_secret: false, value: process.env.AT_SENDER_ID || '' },
  { key: 'environment', label: 'Environment',       is_secret: false, value: process.env.AT_USERNAME === 'sandbox' ? 'sandbox' : 'production' },
];

const AIRTEL_DEFAULTS = [
  { key: 'client_id',     label: 'Client ID',      is_secret: false, value: process.env.AIRTEL_CLIENT_ID     || '' },
  { key: 'client_secret', label: 'Client Secret',  is_secret: true,  value: process.env.AIRTEL_CLIENT_SECRET || '' },
  { key: 'callback_url',  label: 'Callback URL',   is_secret: false, value: process.env.AIRTEL_CALLBACK_URL  || '' },
  { key: 'environment',   label: 'Environment',    is_secret: false, value: process.env.AIRTEL_ENV           || 'sandbox' },
  { key: 'country',       label: 'Country Code',   is_secret: false, value: process.env.AIRTEL_COUNTRY       || 'KE' },
  { key: 'currency',      label: 'Currency Code',  is_secret: false, value: process.env.AIRTEL_CURRENCY      || 'KES' },
];

// Which payment provider is active — only one at a time
const PAYMENT_DEFAULTS = [
  { key: 'active_provider', label: 'Active Payment Provider', is_secret: false, value: 'mpesa' },
];

// ── In-memory cache (TTL: 60s) ────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60_000; // 1 minute

const cacheKey  = (cat, key) => `${cat}:${key}`;
const cacheGet  = (k) => { const e = cache.get(k); return e && Date.now() < e.ttl ? e.value : null; };
const cacheSet  = (k, v) => cache.set(k, { value: v, ttl: Date.now() + CACHE_TTL });
const cacheClear = (cat) => { for (const k of cache.keys()) if (k.startsWith(`${cat}:`)) cache.delete(k); };

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * get(category, key, fallback?)
 * Returns the value for a single setting.
 * Falls back to `fallback` if not found in DB.
 */
const get = async (category, key, fallback = null) => {
  const ck = cacheKey(category, key);
  const cached = cacheGet(ck);
  if (cached !== null) return cached;

  try {
    const row = await Setting.findOne({ where: { category, key } });
    const value = row?.value ?? fallback;
    cacheSet(ck, value);
    return value;
  } catch (err) {
    logger.warn(`Settings get(${category}.${key}) failed: ${err.message}`);
    return fallback;
  }
};

/**
 * getCategory(category)
 * Returns all settings for a category as a plain object { key: value }.
 * Secret values are included (for internal use by services).
 */
const getCategory = async (category) => {
  try {
    const rows = await Setting.findAll({ where: { category } });
    const result = {};
    for (const row of rows) {
      result[row.key] = row.value;
      cacheSet(cacheKey(category, row.key), row.value);
    }
    return result;
  } catch (err) {
    logger.warn(`Settings getCategory(${category}) failed: ${err.message}`);
    return {};
  }
};

/**
 * set(category, key, value)
 * Upserts a single setting.
 */
const set = async (category, key, value) => {
  await Setting.upsert({ category, key, value });
  cacheClear(category);
};

/**
 * setMany(category, kvMap)
 * Upserts multiple settings at once.
 * kvMap: { consumer_key: 'abc', shortcode: '174379', ... }
 */
const setMany = async (category, kvMap) => {
  await Promise.all(
    Object.entries(kvMap).map(([key, value]) =>
      Setting.upsert({ category, key, value: value ?? '' })
    )
  );
  cacheClear(category);
};

/**
 * seedDefaults(category, defaults)
 * Seeds default values if they don't exist yet.
 * Called on app start.
 */
const seedDefaults = async (category, defaults) => {
  for (const d of defaults) {
    const exists = await Setting.findOne({ where: { category, key: d.key } });
    if (!exists) {
      await Setting.create({ category, key: d.key, value: d.value, is_secret: d.is_secret, label: d.label });
    } else if (!exists.label) {
      // Backfill label/is_secret metadata if missing
      await exists.update({ label: d.label, is_secret: d.is_secret });
    }
  }
};

/**
 * initSettings()
 * Seeds all default categories. Called once on app start.
 */
const initSettings = async () => {
  try {
    await seedDefaults('mpesa',    MPESA_DEFAULTS);
    await seedDefaults('packages', PACKAGES_DEFAULTS);
    await seedDefaults('sms',      SMS_DEFAULTS);
    await seedDefaults('airtel',   AIRTEL_DEFAULTS);
    await seedDefaults('payment',  PAYMENT_DEFAULTS);
    logger.info('Settings initialized');
  } catch (err) {
    logger.warn(`Settings init failed: ${err.message}`);
  }
};

module.exports = { get, getCategory, set, setMany, initSettings, cacheClear };