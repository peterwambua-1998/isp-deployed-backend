/**
 * utils/duration.js
 *
 * Single source of truth for all duration and expiry logic.
 * Used by: routes/customers.js, routes/payments.js, jobs/expiryJob.js
 *
 * A package is EITHER:
 *   - minute-based:  duration_minutes > 0, duration_days = 0
 *                    e.g. "1 Hour" = 60 minutes, "3 Minutes" = 3 minutes
 *   - day-based:     duration_days > 0, duration_minutes = 0
 *                    e.g. "1 Month" = 30 days, "7 Days" = 7 days
 *
 * Never both > 0. Never both 0. Validated at the API layer.
 */

/**
 * isMinuteBased(pkg) — true for all hourly / minute timed packages
 */
const isMinuteBased = (pkg) =>
  parseInt(pkg.duration_minutes || 0) > 0 && parseInt(pkg.duration_days || 0) === 0;

/**
 * isDayBased(pkg) — true for all daily / weekly / monthly packages
 */
const isDayBased = (pkg) =>
  parseInt(pkg.duration_days || 0) > 0 && parseInt(pkg.duration_minutes || 0) === 0;

/**
 * calcExpiry(pkg, fromDate?)
 *
 * Returns the Date when a customer's access expires after purchasing pkg.
 *
 * Minute-based: add exact minutes from now.
 *               No EOD rounding — precision matters for "3 Minutes" or "1 Hour".
 *
 * Day-based:    add N calendar days then set time to 23:59:59.
 *               "1 Day" pack bought at 14:30 → expires tomorrow at 23:59:59.
 *               This gives the customer the full remaining today + all of tomorrow.
 *
 * @param  {object} pkg        — Package record
 * @param  {Date}   [fromDate] — start from this time (default: now)
 * @returns {Date}
 */
const calcExpiry = (pkg, fromDate = new Date()) => {
  const expiry = new Date(fromDate);

  if (isMinuteBased(pkg)) {
    expiry.setMinutes(expiry.getMinutes() + parseInt(pkg.duration_minutes));
  } else if (isDayBased(pkg)) {
    expiry.setDate(expiry.getDate() + parseInt(pkg.duration_days));
    expiry.setHours(23, 59, 59, 0);
  } else {
    // Defensive fallback — should never happen with proper validation
    expiry.setDate(expiry.getDate() + 1);
    expiry.setHours(23, 59, 59, 0);
  }

  return expiry;
};

/**
 * durationSeconds(pkg)
 *
 * Returns the FreeRADIUS Session-Timeout in seconds for minute-based packages.
 * MikroTik uses this to hard-cut the session when time runs out.
 * Returns null for day-based packages (Expiration attribute is used instead).
 *
 * @param  {object} pkg
 * @returns {number|null}
 */
const durationSeconds = (pkg) => {
  if (isMinuteBased(pkg)) return parseInt(pkg.duration_minutes) * 60;
  return null;
};

/**
 * humanDuration(pkg) — readable string for logs / SMS
 */
const humanDuration = (pkg) => {
  if (isMinuteBased(pkg)) {
    const m = parseInt(pkg.duration_minutes);
    if (m < 60) return `${m} Minute${m !== 1 ? 's' : ''}`;
    const h    = Math.floor(m / 60);
    const mRem = m % 60;
    if (mRem === 0) return `${h} Hour${h !== 1 ? 's' : ''}`;
    return `${h} Hour${h !== 1 ? 's' : ''} ${mRem} Minutes`;
  }
  if (isDayBased(pkg)) {
    const d = parseInt(pkg.duration_days);
    if (d === 365) return '1 Year';
    if (d === 180) return '6 Months';
    if (d === 90)  return '3 Months';
    if (d === 60)  return '2 Months';
    if (d === 30)  return '1 Month';
    if (d === 14)  return '2 Weeks';
    if (d === 7)   return '1 Week';
    return `${d} Day${d !== 1 ? 's' : ''}`;
  }
  return 'Unknown duration';
};

module.exports = { calcExpiry, durationSeconds, isMinuteBased, isDayBased, humanDuration };