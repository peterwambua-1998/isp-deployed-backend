/**
 * radiusService.js
 *
 * FreeRADIUS uses its own MySQL tables (radcheck, radreply, radusergroup, radgroupreply).
 * Instead of a separate DB connection, we write directly to these tables.
 * This means when your Express app creates a customer, FreeRADIUS immediately
 * knows about them — no sync delay, no extra step.
 *
 * FreeRADIUS table structure (standard rlm_sql schema):
 *   radcheck   — per-user auth checks  (e.g. password)
 *   radreply   — per-user reply attrs  (e.g. IP address)
 *   radusergroup — maps users to groups
 *   radgroupreply — group-level reply attrs (e.g. speed limits)
 */

const mysql = require('mysql2/promise');
const logger = require('../config/logger');

let pool;

const getPool = () => {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.RADIUS_DB_HOST || process.env.DB_HOST,
      database: process.env.RADIUS_DB_NAME || 'radius',
      user: process.env.RADIUS_DB_USER,
      password: process.env.RADIUS_DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return pool;
};

// ── Helpers ────────────────────────────────────────────────────────────────

const upsertCheck = async (conn, username, attribute, op, value) => {
  await conn.execute(
    `INSERT INTO radcheck (username, attribute, op, value) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [username, attribute, op, value]
  );
};

const upsertReply = async (conn, username, attribute, op, value) => {
  await conn.execute(
    `INSERT INTO radreply (username, attribute, op, value) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [username, attribute, op, value]
  );
};

const setUserGroup = async (conn, username, groupname) => {
  await conn.execute(
    `INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE groupname = VALUES(groupname)`,
    [username, groupname]
  );
};

const ensureGroupReply = async (conn, pkg) => {
  const groupname = `pkg_${pkg.id}`;
  // Mikrotik-Rate-Limit: rx-rate/tx-rate from router's perspective
  // rx = what router receives = customer upload
  // tx = what router sends    = customer download
  const rateLimit = `${pkg.speed_upload}k/${pkg.speed_download}k`;

  await conn.execute(
    `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [groupname, 'Mikrotik-Rate-Limit', '=', rateLimit]
  );

  // Data cap — use Mikrotik-specific attributes (Session-Octets-Limit is not supported)
  // Mikrotik-Recv-Limit: total bytes the client can receive (download from client view)
  // Mikrotik-Xmit-Limit: total bytes the client can send (upload from client view)
  if (pkg.data_limit_mb > 0) {
    const limitBytes = String(pkg.data_limit_mb * 1024 * 1024);
    await conn.execute(
      `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [groupname, 'Mikrotik-Recv-Limit', '=', limitBytes]
    );
    await conn.execute(
      `INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [groupname, 'Mikrotik-Xmit-Limit', '=', limitBytes]
    );
  }
};

// ── Public API ─────────────────────────────────────────────────────────────

const { durationSeconds: getDurationSeconds } = require('../utils/duration');

/**
 * Create a RADIUS user with password + speed limits from their package
 */
const createUser = async (customer, pkg) => {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Set password
    await upsertCheck(conn, customer.username, 'Cleartext-Password', ':=', customer.password);

    // 2. Time-based package → use Session-Timeout (seconds)
    //    MikroTik enforces this natively — disconnects exactly when time runs out
    const sessionTimeout = getDurationSeconds(pkg);
    if (sessionTimeout) {
      await upsertCheck(conn, customer.username, 'Session-Timeout', ':=', String(sessionTimeout));
      // Also clear any old Expiration attribute so it doesn't conflict
      await conn.execute(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Expiration'`, [customer.username]);
    } else if (customer.expiry_date) {
      // Day-based package → use Expiration date
      const expiry = new Date(customer.expiry_date).toLocaleDateString('en-US', {
        month: 'short', day: '2-digit', year: 'numeric',
      });
      await upsertCheck(conn, customer.username, 'Expiration', ':=', expiry);
      // Clear any old Session-Timeout
      await conn.execute(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Session-Timeout'`, [customer.username]);
    }

    // 3. Assign static IP if set
    if (customer.static_ip) {
      await upsertReply(conn, customer.username, 'Framed-IP-Address', '=', customer.static_ip);
    }

    // 4. Ensure group exists with correct speed limits
    await ensureGroupReply(conn, pkg);

    // 5. Map user to package group
    await setUserGroup(conn, customer.username, `pkg_${pkg.id}`);

    await conn.commit();
    logger.info(`RADIUS: Created user ${customer.username}${sessionTimeout ? ` (Session-Timeout: ${sessionTimeout}s)` : ''}`);
  } catch (err) {
    await conn.rollback();
    logger.error(`RADIUS: Failed to create user ${customer.username}`, err);
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * Update speed limits when customer changes package
 */
const updateUser = async (customer, pkg) => {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await ensureGroupReply(conn, pkg);
    await setUserGroup(conn, customer.username, `pkg_${pkg.id}`);
    if (customer.expiry_date) {
      const expiry = new Date(customer.expiry_date).toLocaleDateString('en-US', {
        month: 'short', day: '2-digit', year: 'numeric',
      });
      await upsertCheck(conn, customer.username, 'Expiration', ':=', expiry);
    }
    await conn.commit();
    logger.info(`RADIUS: Updated user ${customer.username}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * Disable user by setting Auth-Type := Reject
 */
const disableUser = async (username) => {
  const conn = await getPool().getConnection();
  try {
    await upsertCheck(conn, username, 'Auth-Type', ':=', 'Reject');
    logger.info(`RADIUS: Disabled user ${username}`);
  } finally {
    conn.release();
  }
};

/**
 * Re-enable user by removing the Reject and refreshing expiry
 */
const enableUser = async (username, pkg) => {
  const conn = await getPool().getConnection();
  try {
    await conn.execute(
      `DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'`,
      [username]
    );
    if (pkg) await ensureGroupReply(conn, pkg);
    logger.info(`RADIUS: Enabled user ${username}`);
  } finally {
    conn.release();
  }
};

/**
 * Fully remove user from RADIUS
 */
const deleteUser = async (username) => {
  const conn = await getPool().getConnection();
  try {
    await conn.execute(`DELETE FROM radcheck WHERE username = ?`, [username]);
    await conn.execute(`DELETE FROM radreply WHERE username = ?`, [username]);
    await conn.execute(`DELETE FROM radusergroup WHERE username = ?`, [username]);
    logger.info(`RADIUS: Deleted user ${username}`);
  } finally {
    conn.release();
  }
};

/**
 * registerNas()
 *
 * Adds or updates a router in FreeRADIUS's `nas` table.
 * FreeRADIUS checks this table for every incoming RADIUS request —
 * if the router's IP is not here, ALL auth requests from it are rejected.
 *
 * Called automatically whenever a router is:
 *   - Registered in the billing system (POST /api/routers)
 *   - Updated (IP address or shared secret changed)
 *   - Deleted (removes from NAS table too)
 *
 * FreeRADIUS `nas` table columns:
 *   nasname    — router IP address (used to match incoming requests)
 *   shortname  — human readable label
 *   type       — NAS type: 'other' works for MikroTik
 *   secret     — shared secret (must match /radius secret= in MikroTik)
 *   description
 */
const registerNas = async (router) => {
  const conn = await getPool().getConnection();
  try {
    const secret = process.env.RADIUS_SHARED_SECRET || 'radiussecret';

    await conn.execute(
      `INSERT INTO nas (nasname, shortname, type, secret, description)
       VALUES (?, ?, 'other', ?, ?)
       ON DUPLICATE KEY UPDATE
         shortname   = VALUES(shortname),
         secret      = VALUES(secret),
         description = VALUES(description)`,
      [
        router.ip_address,
        router.name,
        secret,
        `Router: ${router.name} | Location: ${router.location || 'N/A'} | ID: ${router.id}`,
      ]
    );

    logger.info(`RADIUS NAS: Registered router "${router.name}" (${router.ip_address})`);
  } catch (err) {
    logger.error(`RADIUS NAS: Failed to register router ${router.ip_address}`, err);
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * updateNas()
 *
 * Updates the NAS entry when a router's IP or name changes.
 * Uses the old IP to find the record, then updates to the new values.
 */
const updateNas = async (oldIp, router) => {
  const conn = await getPool().getConnection();
  try {
    const secret = process.env.RADIUS_SHARED_SECRET || 'radiussecret';

    await conn.execute(
      `UPDATE nas SET
         nasname     = ?,
         shortname   = ?,
         secret      = ?,
         description = ?
       WHERE nasname = ?`,
      [
        router.ip_address,
        router.name,
        secret,
        `Router: ${router.name} | Location: ${router.location || 'N/A'} | ID: ${router.id}`,
        oldIp,
      ]
    );

    logger.info(`RADIUS NAS: Updated router "${router.name}" (${oldIp} → ${router.ip_address})`);
  } catch (err) {
    logger.error(`RADIUS NAS: Failed to update router ${oldIp}`, err);
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * removeNas()
 *
 * Removes a router from FreeRADIUS's trusted NAS list.
 * Called when a router is deleted from the billing system.
 * After this, FreeRADIUS will reject all requests from that IP.
 */
const removeNas = async (ipAddress) => {
  const conn = await getPool().getConnection();
  try {
    await conn.execute(`DELETE FROM nas WHERE nasname = ?`, [ipAddress]);
    logger.info(`RADIUS NAS: Removed router ${ipAddress}`);
  } catch (err) {
    logger.error(`RADIUS NAS: Failed to remove router ${ipAddress}`, err);
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * listNas()
 *
 * Returns all routers currently registered in FreeRADIUS.
 * Useful for the admin to audit which routers RADIUS trusts.
 */
const listNas = async () => {
  const conn = await getPool().getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT nasname, shortname, type, secret, description, id FROM nas ORDER BY id DESC`
    );
    return rows;
  } catch (err) {
    logger.error('RADIUS NAS: Failed to list NAS entries', err);
    throw err;
  } finally {
    conn.release();
  }
};

/**
 * syncPackageGroup(pkg)
 *
 * Ensures the radgroupreply table has the correct speed limits for a package.
 * Called when a package is created or its speed is updated.
 *
 * This updates ALL customers on this package simultaneously because they are
 * all mapped to the same group (pkg_<uuid>) — FreeRADIUS reads the group
 * on every Access-Accept, so the next auth or CoA re-auth picks up the new speed.
 *
 * @param {object} pkg — Package DB record
 */
const syncPackageGroup = async (pkg) => {
  const conn = await getPool().getConnection();
  try {
    await ensureGroupReply(conn, pkg);
    logger.info(`RADIUS: synced group for package "${pkg.name}" — ${pkg.speed_upload}k/${pkg.speed_download}k`);
  } catch (err) {
    logger.error(`RADIUS: failed to sync group for package "${pkg.name}"`, err);
    throw err;
  } finally {
    conn.release();
  }
};

module.exports = {
  createUser, updateUser, disableUser, enableUser, deleteUser,
  registerNas, updateNas, removeNas, listNas,
  syncPackageGroup,
};