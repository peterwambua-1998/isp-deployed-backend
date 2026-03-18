/**
 * mikrotikService.js
 * Uses node-routeros to talk to MikroTik RouterOS API
 */
const RouterOSAPI = require('node-routeros').RouterOSAPI;
const logger = require('../config/logger');

const getClient = (router) => {
  return new RouterOSAPI({
    host: router.ip_address,
    user: router.api_username,
    password: router.api_password,
    port: router.api_port || 8728,
    timeout: 50000,
  });
};

/**
 * Test connection to a MikroTik router
 */
const ping = async (router) => {
  console.log('ping');
  const conn = getClient(router);
  try {
    await conn.connect();
    const identity = await conn.write('/system/identity/print');
    await conn.close();
    return { online: true, identity: identity[0]?.name };
  } catch (err) {
    logger.warn(`MikroTik ping failed for ${router.ip_address}: ${err.message}`);
    return { online: false, error: err.message };
  }
};

/**
 * Get active PPPoE sessions from MikroTik
 */
const getActiveSessions = async (router) => {
  const conn = getClient(router);
  try {
    await conn.connect();
    const sessions = await conn.write('/ppp/active/print');
    await conn.close();
    return sessions.map((s) => ({
      session_id: s['.id'],
      username: s.name,
      ip: s.address,
      uptime: s.uptime,
      bytes_in: s['bytes-in'],
      bytes_out: s['bytes-out'],
      caller_id: s['caller-id'],
    }));
  } catch (err) {
    logger.error(`MikroTik getActiveSessions failed: ${err.message}`);
    throw new Error(`Could not connect to router: ${err.message}`);
  }
};

/**
 * Get active Hotspot sessions
 */
const getHotspotSessions = async (router) => {
  const conn = getClient(router);
  try {
    await conn.connect();
    const sessions = await conn.write('/ip/hotspot/active/print');
    await conn.close();
    return sessions.map((s) => ({
      session_id: s['.id'],
      username: s.user,
      ip: s.address,
      mac: s['mac-address'],
      uptime: s.uptime,
      bytes_in: s['bytes-in'],
      bytes_out: s['bytes-out'],
    }));
  } catch (err) {
    logger.error(`MikroTik getHotspotSessions failed: ${err.message}`);
    throw new Error(`Could not connect to router: ${err.message}`);
  }
};

/**
 * Disconnect a specific user session (PPPoE or Hotspot)
 */
const disconnectUser = async (router, username) => {
  const conn = getClient(router);
  try {
    await conn.connect();
    // Try PPPoE first
    const pppSessions = await conn.write('/ppp/active/print', [`?name=${username}`]);
    for (const s of pppSessions) {
      await conn.write('/ppp/active/remove', [`=.id=${s['.id']}`]);
    }
    // Try Hotspot
    const hotspotSessions = await conn.write('/ip/hotspot/active/print', [`?user=${username}`]);
    for (const s of hotspotSessions) {
      await conn.write('/ip/hotspot/active/remove', [`=.id=${s['.id']}`]);
    }
    await conn.close();
    logger.info(`MikroTik: Disconnected ${username}`);
    return { disconnected: true };
  } catch (err) {
    logger.error(`MikroTik disconnect failed: ${err.message}`);
    throw err;
  }
};

/**
 * configureServices()
 *
 * Fully configures a MikroTik router via RouterOS API.
 * Accepts an `onLog` callback so the caller can stream each step
 * to the frontend in real time via SSE.
 *
 * @param {object} router        - Router DB record
 * @param {object} options
 *   @param {boolean} enablePppoe        - Set up PPPoE server
 *   @param {boolean} enableHotspot      - Set up Hotspot server
 *   @param {boolean} antiSharing        - Bind hotspot session to MAC
 *   @param {string[]} ports             - e.g. ['ether2','ether3','ether4']
 *   @param {string} radiusIp            - FreeRADIUS server IP
 *   @param {string} radiusSecret        - Shared RADIUS secret
 *   @param {string} bridgeNetwork       - e.g. '192.168.88.0/24'
 *   @param {string} bridgeGateway       - e.g. '192.168.88.1'
 *   @param {string} dhcpRangeStart      - e.g. '192.168.88.10'
 *   @param {string} dhcpRangeEnd        - e.g. '192.168.88.254'
 * @param {function} onLog       - callback(message, status) — 'info'|'success'|'error'
 */
const configureServices = async (router, options = {}, onLog = () => {}) => {
  const {
    enablePppoe = true,
    enableHotspot = false,
    antiSharing = false,
    ports = [],
    radiusIp = process.env.RADIUS_IP || '127.0.0.1',
    radiusSecret = process.env.RADIUS_SHARED_SECRET || 'radiussecret',
    bridgeNetwork  = '10.10.10.0/24',
    bridgeGateway  = '10.10.10.1',
    dhcpRangeStart = '10.10.10.10',
    dhcpRangeEnd   = '10.10.10.254',
  } = options;

  const BRIDGE_NAME = 'billing-bridge';
  const conn = getClient(router);
  const results = [];

  // ── Helper: log a step and record it ──────────────────────────────────────
  const step = (message, status = 'info') => {
    const timestamp = new Date().toTimeString().slice(0, 8);
    const entry = { timestamp, message, status };
    results.push(entry);
    onLog(entry);
    logger.info(`[MikroTik ${router.ip_address}] ${message}`);
  };

  // ── Helper: run a RouterOS command safely ─────────────────────────────────
  const run = async (label, command, args = []) => {
    try {
      const result = await conn.write(command, args);
      step(label, 'success');
      return result;
    } catch (err) {
      const msg = err.message?.toLowerCase() || '';
      const errno = err.errno || '';

      // !empty is a normal RouterOS response for commands that return nothing (set, remove etc.)
      if (errno === 'UNKNOWNREPLY' || msg.includes('!empty') || msg.includes('unknownreply')) {
        step(label, 'success');
        return [];
      }

      // Already configured — idempotent, skip silently
      if (msg.includes('already have') || msg.includes('failure') ||
          msg.includes('already exists') || msg.includes('duplicate')) {
        step(`${label} (already configured, skipping)`, 'info');
        return [];
      }

      throw err;
    }
  };

  try {
    // ── 1. Connect ───────────────────────────────────────────────────────────
    step('Establishing connection to device...');
    await conn.connect();
    step('Connected to router successfully', 'success');

    // ── 2. Ensure management IP is on ether1 (not on bridge ports) ───────────
    // This prevents losing the API connection when bridge ports are added.
    // We check if ether1 already has an IP — if not, we preserve the current one.
    step('Checking management IP...');
    try {
      const addresses = await conn.write('/ip/address/print', ['?interface=ether1']);
      if (addresses.length === 0) {
        // No IP on ether1 — get the router's current IP and move it there
        const allAddresses = await conn.write('/ip/address/print', ['?dynamic=no']);
        const mgmtAddr = allAddresses.find(a =>
          !a.interface.includes(BRIDGE_NAME) &&
          !ports.includes(a.interface)
        );
        if (mgmtAddr) {
          await conn.write('/ip/address/add', [
            `=address=${mgmtAddr.address}`,
            '=interface=ether1',
            '=comment=ISP Management',
          ]).catch(() => {}); // ignore if already exists
          step(`Management IP secured on ether1`, 'success');
        }
      } else {
        step('Management IP already on ether1', 'info');
      }
    } catch (_) {
      step('Management IP check skipped', 'info');
    }

    // ── 3. Network Bridge ────────────────────────────────────────────────────
    step('Setting up network bridge...');
    await run('Creating bridge interface', '/interface/bridge/add', [
      `=name=${BRIDGE_NAME}`,
      '=protocol-mode=rstp',
      '=comment=ISP Billing Bridge',
    ]);

    // ── 4. IP Address on Bridge ──────────────────────────────────────────────
    // Add bridge IP BEFORE adding ports — this way the bridge is ready
    // and we don't lose connectivity when ports are moved into it
    step('Configuring IP addressing...');
    await run(`Setting gateway IP ${bridgeGateway}`, '/ip/address/add', [
      `=address=${bridgeGateway}/24`,
      `=interface=${BRIDGE_NAME}`,
      '=comment=ISP Billing Gateway',
    ]);

    // ── 5. Add Ports to Bridge ───────────────────────────────────────────────
    // Done AFTER bridge IP is set so connectivity is not lost
   if (ports.length > 0) {
      step(`Configuring network ports (${ports.join(', ')})...`);
      for (const port of ports) {
        await run(`Adding ${port} to bridge`, '/interface/bridge/port/add', [
          `=bridge=${BRIDGE_NAME}`,
          `=interface=${port}`,
        ]);
      }
      step(`Added ${ports.length} port(s) to bridge`, 'success');
    }


    // ── 5. DHCP Pool + Server ────────────────────────────────────────────────
    step('Setting up DHCP server...');
    await run('Creating DHCP address pool', '/ip/pool/add', [
      `=name=billing-pool`,
      `=ranges=${dhcpRangeStart}-${dhcpRangeEnd}`,
    ]);
    await run('Creating DHCP network entry', '/ip/dhcp-server/network/add', [
      `=address=${bridgeNetwork}`,
      `=gateway=${bridgeGateway}`,
      `=dns-server=${bridgeGateway},8.8.8.8`,
    ]);
    await run('Adding DHCP server', '/ip/dhcp-server/add', [
      `=name=billing-dhcp`,
      `=interface=${BRIDGE_NAME}`,
      `=address-pool=billing-pool`,
      `=disabled=no`,
    ]);
    step('DHCP server configured', 'success');

    // ── 6. RADIUS ────────────────────────────────────────────────────────────
    step('Configuring RADIUS authentication...');
    await run('Adding RADIUS server', '/radius/add', [
      `=address=${radiusIp}`,
      `=secret=${radiusSecret}`,
      `=service=ppp,hotspot`,
      `=timeout=00:00:03`,
      `=comment=ISP Billing RADIUS`,
    ]);
    await run('Enabling RADIUS incoming (CoA/disconnect)', '/radius/incoming/set', [
      '=accept=yes',
      '=port=3799',
    ]);
    step('RADIUS server configured', 'success');

    // ── 7. PPPoE Server ──────────────────────────────────────────────────────
    if (enablePppoe) {
      step('Configuring PPPoE service...');

      // PPP profile — no use-radius here, that goes in /ppp/aaa
      await run('Creating PPPoE profile', '/ppp/profile/add', [
        '=name=billing-pppoe-profile',
        '=change-tcp-mss=yes',
        '=only-one=yes',
        '=dns-server=8.8.8.8,8.8.4.4',
        '=comment=ISP Billing PPPoE',
      ]);

      // Enable RADIUS for ALL PPP services — this is the correct place
      await run('Enabling RADIUS for PPP', '/ppp/aaa/set', [
        '=use-radius=yes',
        '=accounting=yes',
      ]);

      await run('Adding PPPoE server', '/interface/pppoe-server/server/add', [
        `=service-name=billing-pppoe`,
        `=interface=${BRIDGE_NAME}`,
        '=authentication=mschap2,mschap1,chap,pap',
        '=default-profile=billing-pppoe-profile',
        '=max-sessions=0',
        '=disabled=no',
        '=comment=ISP Billing PPPoE Server',
      ]);
      step('PPPoE server started', 'success');
    }


    // ── 8. Hotspot Server ────────────────────────────────────────────────────
    if (enableHotspot) {
      step('Configuring Hotspot service...');

      const portalBaseUrl = (process.env.PROVISION_BASE_URL || '')
        .replace('/provision', '') || `http://${radiusIp}:3000`;

      // ── Step 1: Upload redirect login.html to router filesystem ────────────
      // MikroTik serves this to customers before they authenticate.
      // It immediately redirects to our Node.js M-Pesa payment portal.
      // The portal handles payment and calls the MikroTik API to log them in.
      step('Uploading captive portal redirect page...');
      const loginHtml = '<html>\n<head>\n<meta http-equiv="pragma" content="no-cache">\n<meta http-equiv="expires" content="-1">\n<meta http-equiv="refresh" content="0; url=' + portalBaseUrl + '/hotspot?mac=$(mac)&ip=$(ip)&router_id=' + router.id + '">\n</head>\n<body><p style="font-family:sans-serif;text-align:center;margin-top:40px">Redirecting to payment portal...</p></body>\n</html>';

      try {
        await conn.write('/file/add', [
          '=name=hotspot/login.html',
          `=contents=${loginHtml}`,
        ]);
        step('Captive portal redirect page uploaded', 'success');
      } catch (_) {
        try {
          const files = await conn.write('/file/print', ['?name=hotspot/login.html']);
          if (files.length > 0) {
            await conn.write('/file/set', [`=.id=${files[0]['.id']}`, `=contents=${loginHtml}`]);
            step('Captive portal redirect page updated', 'success');
          } else {
            step('Could not upload login.html — upload manually via Winbox Files', 'info');
          }
        } catch (_2) {
          step('login.html upload skipped — upload manually via Winbox Files', 'info');
        }
      }

      // ── Step 2: Create hotspot server profile ──────────────────────────────
      await run('Creating Hotspot server profile', '/ip/hotspot/profile/add', [
        '=name=billing-hotspot-profile',
        '=dns-name=hotspot.local',
        '=html-directory=hotspot',
        '=http-cookie-lifetime=1d',
        '=login-by=cookie,http-chap',
      ]);

      // ── Step 3: Enable RADIUS on profile (must be via set, not add) ─────────
      await run('Enabling RADIUS on Hotspot profile', '/ip/hotspot/profile/set', [
        '=numbers=billing-hotspot-profile',
        '=use-radius=yes',
      ]);

      // ── Step 4: Walled garden — allow portal + DNS without auth ────────────
      const portalHost = portalBaseUrl.replace(/^https?:\/\//, '').split(':')[0];
      await run('Adding walled garden for portal', '/ip/hotspot/walled-garden/ip/add', [
        '=action=accept',
        `=dst-host=${portalHost}`,
      ]).catch(() => {});
      await run('Adding walled garden for DNS', '/ip/hotspot/walled-garden/ip/add', [
        '=action=accept',
        '=protocol=udp',
        '=dst-port=53',
      ]).catch(() => {});

      // ── Step 5: Add hotspot server (connection may drop — expected) ─────────
      try {
        await conn.write('/ip/hotspot/add', [
          '=name=billing-hotspot',
          `=interface=${BRIDGE_NAME}`,
          '=profile=billing-hotspot-profile',
          '=address-pool=billing-pool',
          '=disabled=no',
        ]);
        step('Hotspot server started', 'success');
      } catch (err) {
        if (err.errno === -110 || err.message?.includes('closed') ||
            err.message?.includes('timeout') || err.message?.includes('ECONNRESET')) {
          step('Hotspot server started (connection reset expected)', 'success');
          await new Promise(r => setTimeout(r, 3000));
          try { await conn.connect(); step('Reconnected to router', 'success'); } catch (_) {}
        } else {
          throw err;
        }
      }

      // ── Step 6: Anti-sharing ───────────────────────────────────────────────
       if (antiSharing) {
        step('Enabling Hotspot Anti-Sharing Protection...');
        // TTL method: set TTL=1 on packets leaving the bridge toward clients
        // When a customer tries to share their connection via hotspot/tethering,
        // the packet TTL decrements to 0 at the next router hop and gets dropped
        await run('Adding TTL anti-sharing mangle rule', '/ip/firewall/mangle/add', [
          '=action=change-ttl',
          '=chain=postrouting',
          '=new-ttl=set:1',
          `=out-interface=${BRIDGE_NAME}`,
          '=passthrough=yes',
          '=comment=ISP:Anti-Sharing TTL',
        ]);
        // Move the rule to top so it's evaluated first
        await run('Moving anti-sharing rule to top', '/ip/firewall/mangle/move', [
          '=numbers=[find comment="ISP:Anti-Sharing TTL"]',
          '=destination=0',
        ]).catch(() => {}); // non-fatal if move fails
        step('Anti-sharing protection enabled (TTL method)', 'success');
      }
    }
    // ── 10. Firewall — protect router from LAN abuse ─────────────────────────
    step('Applying firewall rules...');
    await run('Blocking invalid connections', '/ip/firewall/filter/add', [
      '=chain=input',
      '=connection-state=invalid',
      '=action=drop',
      '=comment=ISP:Drop invalid',
    ]);
    await run('Allowing RADIUS traffic', '/ip/firewall/filter/add', [
      '=chain=input',
      '=protocol=udp',
      '=dst-port=1812,1813,3799',
      '=action=accept',
      '=comment=ISP:Allow RADIUS',
    ]);
    step('Firewall rules applied', 'success');

    // ── Done ──────────────────────────────────────────────────────────────────
    step('✅ Configuration complete! Router is ready.', 'success');
    await conn.close();

    return { success: true, steps: results };
  } catch (err) {
    const msg = `Configuration failed: ${err.message}`;
    step(msg, 'error');
    logger.error(`MikroTik configureServices failed for ${router.ip_address}`, err);
    try { await conn.close(); } catch (_) {}
    return { success: false, steps: results, error: err.message };
  }
};

/**
 * hotspotLogin()
 *
 * Auto-logs a customer into the MikroTik Hotspot immediately after payment.
 * Called after M-Pesa callback confirms payment — no action needed from customer.
 *
 * MikroTik matches the customer by their MAC address (captured when they
 * first connected to WiFi and hit the captive portal redirect).
 *
 * @param {object} router    - Router DB record
 * @param {string} username  - RADIUS username
 * @param {string} password  - RADIUS password (plaintext)
 * @param {string} ip        - Customer's current IP on the hotspot network
 * @param {string} mac       - Customer's MAC address
 */
const hotspotLogin = async (router, { username, password, ip, mac }) => {
  const conn = getClient(router);
  try {
    await conn.connect();

    // First check if they already have an active session — avoid duplicates
    const existing = await conn.write('/ip/hotspot/active/print', [
      `?mac-address=${mac}`,
    ]);
    if (existing.length > 0) {
      logger.info(`Hotspot: ${username} already has active session, removing old one`);
      await conn.write('/ip/hotspot/active/remove', [`=.id=${existing[0]['.id']}`]);
    }

    // Log the customer in via RouterOS API
    // MikroTik will authenticate against RADIUS using these credentials
    await conn.write('/ip/hotspot/active/login', [
      `=user=${username}`,
      `=password=${password}`,
      `=ip=${ip}`,
      `=mac-address=${mac}`,
    ]);

    await conn.close();
    logger.info(`Hotspot: Auto-logged in ${username} (IP: ${ip}, MAC: ${mac})`);
    return { success: true };
  } catch (err) {
    logger.error(`Hotspot login failed for ${username}: ${err.message}`);
    try { await conn.close(); } catch (_) {}
    return { success: false, error: err.message };
  }
};

/**
 * getResourceStats()
 * Pulls CPU, memory, and disk usage from MikroTik /system/resource.
 * Called after configure-services completes and by the health job every 2 min.
 * Results are stored on the Router record and shown on the detail page.
 */
const getResourceStats = async (router) => {
  const conn = getClient(router);
  try {
    await conn.connect();
    const res = await conn.write('/system/resource/print');
    await conn.close();

    if (!res || res.length === 0) return { cpu_load: 0, memory_percent: 0, disk_percent: 0 };

    const r         = res[0];
    const totalMem  = parseInt(r['total-memory']    || 0);
    const freeMem   = parseInt(r['free-memory']     || 0);
    const totalDisk = parseInt(r['total-hdd-space'] || 0);
    const freeDisk  = parseInt(r['free-hdd-space']  || 0);
    const cpuLoad   = parseInt(r['cpu-load']        || 0);

    return {
      cpu_load:       cpuLoad,
      memory_percent: totalMem  > 0 ? Math.round(((totalMem  - freeMem)  / totalMem)  * 100) : 0,
      disk_percent:   totalDisk > 0 ? Math.round(((totalDisk - freeDisk) / totalDisk) * 100) : 0,
      total_memory:   totalMem,
      free_memory:    freeMem,
      total_disk:     totalDisk,
      free_disk:      freeDisk,
      uptime:         r['uptime'],
      version:        r['version'],
      board_name:     r['board-name'],
    };
  } catch (err) {
    logger.error(`getResourceStats failed for ${router.ip_address}: ${err.message}`);
    throw err;
  }
};

module.exports = {
  ping,
  getActiveSessions,
  getHotspotSessions,
  disconnectUser,
  configureServices,
  hotspotLogin,
  getResourceStats,
};