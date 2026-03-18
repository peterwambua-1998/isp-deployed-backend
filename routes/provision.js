/**
 * routes/provision.js
 *
 * PUBLIC endpoints — MikroTik devices call these directly, no JWT auth needed.
 * Mounted at /provision in app.js.
 *
 * GET  /provision/:token
 *   MikroTik runs:  /tool fetch url="https://yourdomain.com/provision/<token>" \
 *                     dst-path=billing.rsc
 *                   /import billing.rsc
 *   Returns a RouterOS .rsc script that:
 *     1. Creates a dedicated billing API user on the MikroTik
 *     2. Configures RADIUS pointing at our FreeRADIUS server
 *     3. Enables CoA (disconnect) port 3799
 *     4. Uses /tool fetch to POST the router's own IP + new credentials back to us
 *
 * POST /provision/:token/callback
 *   The .rsc script itself calls this after it runs.
 *   Body: { ip_address, api_username, api_password, api_port }
 *   We update the Router record and register the IP in FreeRADIUS nas table.
 *
 * Security: both endpoints validate the signed JWT in the URL token.
 * The token expires in 1 hour and contains the router_id.
 */

const express = require('express');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { Router } = require('../models');
const radiusService = require('../services/radiusService');
const logger  = require('../config/logger');

const router = express.Router();

// ─── GET /:token  →  returns RouterOS .rsc provisioning script ───────────────
router.get('/:token', async (req, res) => {
  try {
    let decoded;
    try {
      decoded = jwt.verify(req.params.token, process.env.PROVISION_SECRET);
    } catch (jwtErr) {
      logger.warn(`Provision GET: invalid token — ${jwtErr.message}`);
      return res.status(400).send('# Error: Invalid or expired provisioning token\r\n');
    }

    if (decoded.action !== 'provision') {
      return res.status(400).send('# Error: Wrong token type\r\n');
    }

    const routerDevice = await Router.findByPk(decoded.router_id);
    if (!routerDevice) {
      return res.status(404).send('# Error: Router record not found\r\n');
    }

    const radiusIp     = process.env.RADIUS_IP            || '127.0.0.1';
    const radiusSecret = process.env.RADIUS_SHARED_SECRET || 'radiussecret';

    // Callback URL: POST /provision/:token/callback
    // We derive it from PROVISION_BASE_URL (e.g. https://billing.yourdomain.com/provision)
    const baseUrl     = (process.env.PROVISION_BASE_URL).replace(/\/$/, '');
    const callbackUrl = `${baseUrl}/${req.params.token}/callback`;

    // Generate a strong random password for the dedicated billing API user.
    // This password is embedded in the script AND sent back in the callback —
    // we store it so the health job and configure-services can connect later.
    const apiPassword = crypto.randomBytes(10).toString('hex'); // 20-char hex

    // ── RouterOS .rsc script ─────────────────────────────────────────────────
    // Notes on RouterOS scripting:
    //  - Line continuation uses \  (single backslash, no space after)
    //  - String interpolation uses $varName inside double-quoted strings
    //  - /tool fetch http-data sends the body as application/x-www-form-urlencoded
    //    UNLESS http-header-field sets Content-Type — but RouterOS /tool fetch
    //    does not support custom Content-Type in all versions.
    //    We use form-encoded key=value pairs which work universally.
    //  - IP detection: we get the first non-loopback IP from /ip address
     const script = [
      '# ==============================================================',
      `# ISP Billing Provisioning Script`,
      `# Router : ${routerDevice.name}`,
      `# Created: ${new Date().toISOString()}`,
      '# ==============================================================',
      ':log info "ISPBilling: provisioning started"',
      '',
      '# -- 1. Create billing API user group --',
      ':do { /user/group/add name=billing-api policy=read,write,api comment="ISP Billing API" } on-error={}',
      '',
      '# -- 2. Create billing API user --',
      ':do { /user/remove [/user/find name=billing_user] } on-error={}',
      `:do { /user/add name=billing_user group=billing-api password="${apiPassword}" comment="ISP Billing" } on-error={}`,
      '',
      '# -- 3. Add RADIUS server --',
      ':do { /radius/remove [/radius/find comment="ISP-Billing-RADIUS"] } on-error={}',
      `:do { /radius/add address=${radiusIp} secret="${radiusSecret}" service=ppp,hotspot timeout=3000 comment="ISP-Billing-RADIUS" } on-error={}`,
      '',
      '# -- 4. Enable CoA --',
      ':do { /radius/incoming/set accept=yes port=3799 } on-error={}',
      '',
      '# -- 5. Detect primary IP --',
      ':local myIp ""',
      ':foreach addr in=[/ip/address/find where !disabled] do={',
      '  :if ($myIp = "") do={',
      '    :local full [/ip/address/get $addr address]',
      '    :local candidate [:pick $full 0 [:find $full "/"]]',
      '    :if ($candidate != "127.0.0.1") do={ :set myIp $candidate }',
      '  }',
      '}',
      ':if ($myIp = "") do={ :log error "ISPBilling: no IP found"; :error "no IP" }',
      ':log info ("ISPBilling: detected IP=" . $myIp)',
      '',
      '# -- 6. Send callback (all on one line - no continuations) --',
      `:local cbUrl "${callbackUrl}"`,
      `:local postData ("ip_address=" . $myIp . "&api_username=billing_user&api_password=${apiPassword}&api_port=8728")`,
      ':log info ("ISPBilling: posting to " . $cbUrl)',
      ':do { /tool/fetch mode=http url=$cbUrl http-method=post http-data=$postData output=none } on-error={ :log error "ISPBilling: callback failed - check PROVISION_BASE_URL and port forwarding" }',
      ':log info "ISPBilling: provisioning script complete"',
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="billing.rsc"');
    return res.send(script);

  } catch (err) {
    logger.error('Provision script error:', err);
    return res.status(500).send('# Internal server error\r\n');
  }
});

// ─── POST /:token/callback  →  MikroTik reports its IP + credentials ─────────
router.post('/:token/callback', async (req, res) => {

  logger.warn(req);
  try {
    let decoded;
    try {
      decoded = jwt.verify(req.params.token, process.env.PROVISION_SECRET);
    } catch (jwtErr) {
      logger.warn(`Provision callback: invalid token — ${jwtErr.message}`);
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }

    if (decoded.action !== 'provision') {
      return res.status(400).json({ success: false, message: 'Wrong token type' });
    }

    // RouterOS /tool fetch sends form-encoded body (application/x-www-form-urlencoded)
    // express.urlencoded() in app.js already parses this
    const { ip_address, api_username, api_password, api_port } = req.body;

    if (!ip_address || ip_address === '0.0.0.0') {
      logger.warn(`Provision callback for router ${decoded.router_id}: missing or invalid ip_address`);
      return res.status(400).json({ success: false, message: 'Valid ip_address is required' });
    }

    // Validate it looks like an IPv4 address
    const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Re.test(ip_address)) {
      logger.warn(`Provision callback: invalid IP format: "${ip_address}"`);
      return res.status(400).json({ success: false, message: 'Invalid ip_address format' });
    }

    const routerDevice = await Router.findByPk(decoded.router_id);
    if (!routerDevice) {
      logger.warn(`Provision callback: router ${decoded.router_id} not found`);
      return res.status(404).json({ success: false, message: 'Router not found' });
    }

    // Update router with the real IP and API credentials the script just created
    await routerDevice.update({
      ip_address,
      api_username:   api_username || 'billing_user',
      api_password:   api_password || '',
      api_port:       parseInt(api_port) || 8728,
      is_provisioned: true,
      status:         'online',
      last_seen:      new Date(),
    });

    logger.info(`Router "${routerDevice.name}" provisioned — IP: ${ip_address}`);

    // Register the router's real IP in FreeRADIUS nas table so RADIUS
    // will accept authentication requests from this MikroTik device
    try {
      await radiusService.registerNas(routerDevice);
      logger.info(`RADIUS NAS registered for ${routerDevice.name} (${ip_address})`);
    } catch (nasErr) {
      // Non-fatal — router is provisioned, RADIUS sync can be retried manually
      logger.warn(`Router provisioned but RADIUS NAS sync failed: ${nasErr.message}`);
    }

    // Respond with 200 — MikroTik doesn't care about the body
    return res.json({ success: true });

  } catch (err) {
    logger.error('Provision callback error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;