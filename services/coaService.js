/**
 * services/coaService.js
 *
 * Change of Authorization (CoA) — RFC 3576
 *
 * Sends RADIUS CoA/Disconnect packets directly to MikroTik's RADIUS
 * incoming port (3799). This lets your server push changes to a live
 * session without the customer doing anything.
 *
 * Two packet types:
 *
 *   Disconnect-Request (40)
 *     → Immediately terminates a live session
 *     → MikroTik drops the connection, customer must reconnect
 *     → Used when: suspending, expiry, data cap hit, admin kicks user
 *
 *   CoA-Request (43)
 *     → Modifies an active session without disconnecting
 *     → Used when: package upgrade/downgrade (speed change)
 *     → MikroTik applies new rate limit mid-session instantly
 *
 * How it works:
 *   1. We build a raw UDP RADIUS packet with the correct attributes
 *   2. Send it to MikroTik on port 3799 (RADIUS incoming port)
 *   3. MikroTik applies the change and sends back Ack or Nak
 *
 * Prerequisites on MikroTik (done by configureServices already):
 *   /radius incoming set accept=yes port=3799
 *
 * Node has no native RADIUS library that supports CoA well,
 * so we build the UDP packet manually — it's straightforward.
 */

const dgram = require('dgram');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { Session, Router } = require('../models');
const logger = require('../config/logger');

// RADIUS packet codes
const CODES = {
  COA_REQUEST: 43,
  COA_ACK: 44,
  COA_NAK: 45,
  DISCONNECT_REQUEST: 40,
  DISCONNECT_ACK: 41,
  DISCONNECT_NAK: 42,
};

// RADIUS attribute type numbers we need
const ATTRS = {
  USER_NAME: 1,
  FRAMED_IP_ADDRESS: 8,
  VENDOR_SPECIFIC: 26,   // for Mikrotik-Rate-Limit
  ACCT_SESSION_ID: 44,
  EVENT_TIMESTAMP: 55,
};

const MIKROTIK_VENDOR_ID = 14988;
const MIKROTIK_RATE_LIMIT_ATTR = 8;

// ── Low-level packet builder ────────────────────────────────────────────────

/**
 * Builds a raw RADIUS CoA/Disconnect UDP packet.
 *
 * RADIUS packet structure:
 *   1 byte  — Code
 *   1 byte  — Identifier (random)
 *   2 bytes — Length
 *  16 bytes — Authenticator (MD5 hash)
 *   N bytes — Attributes (TLV format)
 */
const buildPacket = (code, secret, attributes) => {
  const identifier = Math.floor(Math.random() * 256);

  // Build attributes buffer
  const attrBuffers = [];

  for (const attr of attributes) {
    if (attr.type === ATTRS.VENDOR_SPECIFIC) {
      // VSA structure: Type(1) + Length(1) + VendorId(4) + VendorType(1) + VendorLength(1) + Value
      const valueLen = attr.value.length;
      const vsaBuf = Buffer.alloc(2 + 4 + 2 + valueLen);
      vsaBuf.writeUInt8(26, 0);                          // Type = Vendor-Specific
      vsaBuf.writeUInt8(2 + 4 + 2 + valueLen, 1);       // Length
      vsaBuf.writeUInt32BE(attr.vendorId, 2);            // Vendor ID
      vsaBuf.writeUInt8(attr.vendorType, 6);             // Vendor Attr Type
      vsaBuf.writeUInt8(2 + valueLen, 7);                // Vendor Attr Length
      attr.value.copy(vsaBuf, 8);
      attrBuffers.push(vsaBuf);
    } else {
      const valueBuf = Buffer.isBuffer(attr.value) ? attr.value : Buffer.from(String(attr.value), 'utf8');
      const buf = Buffer.alloc(2 + valueBuf.length);
      buf.writeUInt8(attr.type, 0);
      buf.writeUInt8(2 + valueBuf.length, 1);
      valueBuf.copy(buf, 2);
      attrBuffers.push(buf);
    }
  }

  const attrsBuffer = Buffer.concat(attrBuffers);
  const length = 20 + attrsBuffer.length; // 20 = header size

  // Authenticator = MD5(Code + ID + Length + ZeroAuth + Attrs + Secret)
  const zeroAuth = Buffer.alloc(16, 0);
  const header = Buffer.alloc(4);
  header.writeUInt8(code, 0);
  header.writeUInt8(identifier, 1);
  header.writeUInt16BE(length, 2);

  const hash = crypto.createHash('md5')
    .update(header)
    .update(zeroAuth)
    .update(attrsBuffer)
    .update(Buffer.from(secret, 'utf8'))
    .digest();

  const packet = Buffer.concat([header, hash, attrsBuffer]);
  return { packet, identifier };
};

/**
 * Sends a CoA/Disconnect packet via UDP and waits for Ack/Nak.
 * Resolves with { success, code, message }.
 */
const sendPacket = (nasIp, nasPort = 3799, packet, expectedAck, expectedNak) => {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const TIMEOUT_MS = 5000;

    const timer = setTimeout(() => {
      socket.close();
      resolve({ success: false, message: 'Timeout — no response from router' });
    }, TIMEOUT_MS);

    socket.on('message', (msg) => {
      clearTimeout(timer);
      socket.close();
      const responseCode = msg.readUInt8(0);
      if (responseCode === expectedAck) {
        resolve({ success: true, message: 'Acknowledged by router' });
      } else if (responseCode === expectedNak) {
        resolve({ success: false, message: 'Rejected by router (NAK)' });
      } else {
        resolve({ success: false, message: `Unexpected response code: ${responseCode}` });
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      resolve({ success: false, message: err.message });
    });

    socket.send(packet, 0, packet.length, nasPort, nasIp);
  });
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * disconnectUser()
 *
 * Sends a Disconnect-Request to immediately terminate a live session.
 * Identifies the session by username + session ID (most reliable).
 *
 * Called when:
 *   - Admin suspends a customer
 *   - Customer account expires (expiry job)
 *   - Data cap hit (accounting interim update)
 *   - Admin manually kicks a user
 *
 * @param {string} nasIp      - MikroTik router IP
 * @param {string} username   - RADIUS username
 * @param {string} sessionId  - RADIUS AcctSessionId (from active Session record)
 */
const disconnectUser = async (nasIp, username, sessionId = null) => {
  const secret = process.env.RADIUS_SHARED_SECRET || 'radiussecret';

  // If no sessionId provided, look up the active session
  if (!sessionId) {
    const session = await Session.findOne({
      where: { username, is_active: true, nas_ip: nasIp },
    });
    if (session) sessionId = session.session_id;
  }

  const attributes = [
    { type: ATTRS.USER_NAME, value: Buffer.from(username, 'utf8') },
  ];

  if (sessionId) {
    attributes.push({ type: ATTRS.ACCT_SESSION_ID, value: Buffer.from(sessionId, 'utf8') });
  }

  logger.info(`CoA: Sending Disconnect-Request to ${nasIp} for user ${username}`);

  const { packet } = buildPacket(CODES.DISCONNECT_REQUEST, secret, attributes);
  const result = await sendPacket(nasIp, 3799, packet, CODES.DISCONNECT_ACK, CODES.DISCONNECT_NAK);

  if (result.success) {
    logger.info(`CoA: Disconnect ACK from ${nasIp} for ${username}`);
  } else {
    logger.warn(`CoA: Disconnect failed for ${username} on ${nasIp}: ${result.message}`);
  }

  return result;
};

/**
 * changeSpeed()
 *
 * Sends a CoA-Request to update a customer's speed mid-session.
 * The customer stays connected — MikroTik applies the new rate limit instantly.
 *
 * Called when:
 *   - Admin upgrades/downgrades a customer's package while they're online
 *
 * @param {string} nasIp         - MikroTik router IP
 * @param {string} username      - RADIUS username
 * @param {string} sessionId     - RADIUS AcctSessionId
 * @param {number} uploadKbps    - New upload speed in Kbps
 * @param {number} downloadKbps  - New download speed in Kbps
 */
const changeSpeed = async (nasIp, username, sessionId, uploadKbps, downloadKbps) => {
  const secret = process.env.RADIUS_SHARED_SECRET || 'radiussecret';

  // Mikrotik-Rate-Limit format: "upload/download" e.g. "5120k/10240k"
  const rateLimit = `${uploadKbps}k/${downloadKbps}k`;

  const attributes = [
    { type: ATTRS.USER_NAME, value: Buffer.from(username, 'utf8') },
    { type: ATTRS.ACCT_SESSION_ID, value: Buffer.from(sessionId, 'utf8') },
    {
      type: ATTRS.VENDOR_SPECIFIC,
      vendorId: MIKROTIK_VENDOR_ID,
      vendorType: MIKROTIK_RATE_LIMIT_ATTR,
      value: Buffer.from(rateLimit, 'utf8'),
    },
  ];

  logger.info(`CoA: Sending CoA-Request to ${nasIp} — ${username} new speed: ${rateLimit}`);

  const { packet } = buildPacket(CODES.COA_REQUEST, secret, attributes);
  const result = await sendPacket(nasIp, 3799, packet, CODES.COA_ACK, CODES.COA_NAK);

  if (result.success) {
    logger.info(`CoA: Speed change ACK from ${nasIp} for ${username} → ${rateLimit}`);
  } else {
    logger.warn(`CoA: Speed change failed for ${username}: ${result.message}`);
  }

  return { ...result, rate_limit: rateLimit };
};

/**
 * disconnectAllOnRouter()
 *
 * Disconnects every active session on a specific router.
 * Used when decommissioning a router or during maintenance.
 */
const disconnectAllOnRouter = async (nasIp) => {
  const sessions = await Session.findAll({
    where: { nas_ip: nasIp, is_active: true },
  });

  if (sessions.length === 0) {
    return { success: true, disconnected: 0, message: 'No active sessions found' };
  }

  const results = { success: 0, failed: 0, total: sessions.length };

  for (const session of sessions) {
    const result = await disconnectUser(nasIp, session.username, session.session_id);
    if (result.success) results.success++;
    else results.failed++;
  }

  logger.info(`CoA: Disconnected ${results.success}/${results.total} sessions on ${nasIp}`);
  return results;
};

module.exports = { disconnectUser, changeSpeed, disconnectAllOnRouter };
