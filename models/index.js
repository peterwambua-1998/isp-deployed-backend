const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// ─── Admin / ISP Staff ────────────────────────────────────────────────────────
const Admin = sequelize.define('Admin', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.ENUM('superadmin', 'admin', 'support'), defaultValue: 'admin' },
  phone: { type: DataTypes.STRING, allowNull: false, defaultValue: '+254715100539' },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
}, {
  tableName: 'Admins',
});

// ─── Packages (Speed Plans) ───────────────────────────────────────────────────
//
// Duration rules (enforced at model level + API layer):
//
//   duration_days    > 0, duration_minutes = 0  → day-based  (monthly, weekly, etc.)
//   duration_minutes > 0, duration_days    = 0  → minute-based (hotspot timed packs)
//
//   Both ZERO    → invalid — caught by the validate hook below
//   Both NON-ZERO → invalid — caught by the validate hook below
//
const Package = sequelize.define('Package', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  type: { type: DataTypes.ENUM('hotspot', 'pppoe'), allowNull: false },

  price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    validate: { min: 0 },
  },

  // duration_days: calendar days the subscription is valid (0 for minute-based packs)
  duration_days: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0 },
  },

  // duration_minutes: exact minutes until session expires (0 for day-based packs)
  // Used for hotspot packs: 3min, 15min, 1hr, 2hr, etc.
  // FreeRADIUS receives this as Session-Timeout (seconds) in the Access-Accept.
  duration_minutes: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0 },
  },

  speed_download: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 128 },   // minimum 128 Kbps
    comment: 'Download speed limit in Kbps',
  },
  speed_upload: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: { min: 128 },   // minimum 128 Kbps
    comment: 'Upload speed limit in Kbps',
  },

  // data_limit_mb: 0 = unlimited
  data_limit_mb: {
    type: DataTypes.BIGINT,
    defaultValue: 0,
    validate: { min: 0 },
    comment: '0 = unlimited data',
  },

  is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
}, {
  tableName: 'Packages',

  validate: {
    // ── Mutual exclusion: exactly one of days/minutes must be set ──────────
    durationMutuallyExclusive() {
      const days = parseInt(this.duration_days || 0);
      const minutes = parseInt(this.duration_minutes || 0);

      if (days === 0 && minutes === 0) {
        throw new Error(
          'A package must have either duration_days or duration_minutes set — both cannot be 0.'
        );
      }
      if (days > 0 && minutes > 0) {
        throw new Error(
          'A package cannot have both duration_days and duration_minutes set — choose one.'
        );
      }
    },

    // ── Hotspot packs must be minute-based ─────────────────────────────────
    // Day-based hotspot packs work but are uncommon (1-day passes use duration_days=1).
    // This is intentionally NOT enforced here — we allow both for flexibility.
    // The key constraint is the mutual exclusion above.
  },
});

// ─── Routers (MikroTik Devices) ───────────────────────────────────────────────
const Router = sequelize.define('Router', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },

  // ip_address is populated AFTER provisioning callback — NOT entered by admin.
  // Stored as '0.0.0.0' until MikroTik calls back with its real IP.
  ip_address: { type: DataTypes.STRING, allowNull: false, defaultValue: '0.0.0.0' },
  api_port: { type: DataTypes.INTEGER, defaultValue: 8728 },

  // api_username and api_password are populated from the provisioning callback.
  // The .rsc script we push creates a dedicated billing user on the MikroTik.
  api_username: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
  api_password: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },

  location: { type: DataTypes.STRING },

  // Wizard step 1 selections — stored so the configure-services SSE job
  // can re-run without the admin having to re-enter them
  service_types: { type: DataTypes.JSON, defaultValue: ['pppoe'] },  // ['pppoe','hotspot']
  ethernet_ports: { type: DataTypes.JSON, defaultValue: [] },         // ['ether2','ether3']
  anti_sharing: { type: DataTypes.BOOLEAN, defaultValue: false },

  // true once MikroTik has called back at POST /provision/:token/callback
  is_provisioned: { type: DataTypes.BOOLEAN, defaultValue: false },

  // Resource stats — updated by routerHealthJob every 2 minutes
  cpu_usage: { type: DataTypes.FLOAT, defaultValue: 0 },
  memory_usage: { type: DataTypes.FLOAT, defaultValue: 0 },
  disk_usage: { type: DataTypes.FLOAT, defaultValue: 0 },
  last_seen: { type: DataTypes.DATE },
  offline_notification_sent: {type: DataTypes.BOOLEAN, defaultValue: false},

  status: {
    type: DataTypes.ENUM('online', 'offline', 'unprovisioned'),
    defaultValue: 'unprovisioned',
  },
}, {
  tableName: 'Routers',
});

// ─── Customers ────────────────────────────────────────────────────────────────
const Customer = sequelize.define('Customer', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  full_name: { type: DataTypes.STRING, allowNull: false },
  phone: { type: DataTypes.STRING, allowNull: false, unique: true },
  email: { type: DataTypes.STRING },
  username: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },

  status: {
    type: DataTypes.ENUM('active', 'suspended', 'expired', 'new'),
    defaultValue: 'new',
  },
  service_type: {
    type: DataTypes.ENUM('hotspot', 'pppoe'),
    allowNull: false,
  },

  static_ip: { type: DataTypes.STRING },

  // expiry_date is calculated by utils/duration.js calcExpiry() at time of payment.
  // For minute-based packs: now + duration_minutes  (exact, no EOD rounding)
  // For day-based packs:    now + duration_days days, time set to 23:59:59
  expiry_date: { type: DataTypes.DATE },

  package_id: { type: DataTypes.UUID },
  router_id: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'Customers',
});

// ─── Payments ─────────────────────────────────────────────────────────────────
const Payment = sequelize.define('Payment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  customer_id: { type: DataTypes.UUID, allowNull: false },
  package_id: { type: DataTypes.UUID, allowNull: false },

  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    validate: { min: 0 },
  },
  method: {
    type: DataTypes.ENUM('mpesa', 'cash', 'bank', 'manual'),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('pending', 'completed', 'failed'),
    defaultValue: 'pending',
  },
  // source tells the M-Pesa callback what to do after payment is confirmed:
  //   'admin'   → update RADIUS + expiry (standard renewal by admin)
  //   'hotspot' → update RADIUS + expiry + auto-login via MikroTik API
  source: {
    type: DataTypes.ENUM('admin', 'hotspot'),
    defaultValue: 'admin',
  },



  mpesa_receipt: { type: DataTypes.STRING },
  mpesa_checkout_id: { type: DataTypes.STRING },
  phone: { type: DataTypes.STRING },
  notes: { type: DataTypes.TEXT },
  paid_at: { type: DataTypes.DATE },
}, {
  tableName: 'Payments',
});

// ─── RADIUS Sessions ──────────────────────────────────────────────────────────
// Mirrors FreeRADIUS radacct — written by routes/accounting.js when FreeRADIUS
// posts accounting Start/Stop/Interim-Update records.
const Session = sequelize.define('Session', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  customer_id: { type: DataTypes.UUID },
  username: { type: DataTypes.STRING, allowNull: false },
  session_id: { type: DataTypes.STRING },
  nas_ip: { type: DataTypes.STRING },
  framed_ip: { type: DataTypes.STRING },
  bytes_in: { type: DataTypes.BIGINT, defaultValue: 0 },
  bytes_out: { type: DataTypes.BIGINT, defaultValue: 0 },
  started_at: { type: DataTypes.DATE },
  stopped_at: { type: DataTypes.DATE },
  terminate_cause: { type: DataTypes.STRING },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true },

  // warned_80: true once we've sent a data-cap 80% warning SMS for this session
  warned_80: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
  tableName: 'Sessions',
});

// ─── Hotspot Sessions (captive portal payment flow) ───────────────────────────
// Created when a customer lands on the captive portal.
// Tracks their MAC, IP, and payment state so we can auto-login them after payment.
const HotspotSession = sequelize.define('HotspotSession', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  mac: { type: DataTypes.STRING, allowNull: false },
  ip: { type: DataTypes.STRING },
  router_id: { type: DataTypes.UUID },
  customer_id: { type: DataTypes.UUID },
  package_id: { type: DataTypes.UUID },
  phone: { type: DataTypes.STRING },
  checkout_id: { type: DataTypes.STRING },

  status: {
    type: DataTypes.ENUM('pending', 'paid', 'logged_in', 'expired'),
    defaultValue: 'pending',
  },

  // expires_at: 30-minute window to complete payment before session is discarded
  expires_at: { type: DataTypes.DATE },
}, {
  tableName: 'HotspotSessions',
});

// ─── Invoices ─────────────────────────────────────────────────────────────────
// An invoice is auto-generated when a Payment reaches status='completed'.
// invoice_number format: INV-YYYYMM-XXXXX  (e.g. INV-202501-00042)
// The PDF is generated on-the-fly by routes/invoices.js — nothing stored on disk.
const Invoice = sequelize.define('Invoice', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  invoice_number: { type: DataTypes.STRING, allowNull: false, unique: true },
  customer_id: { type: DataTypes.UUID, allowNull: false },
  payment_id: { type: DataTypes.UUID, allowNull: false, unique: true }, // 1-to-1 with Payment
  package_id: { type: DataTypes.UUID, allowNull: false },

  // Snapshot fields — copied from Payment/Package at invoice creation time
  // so the invoice remains accurate even if the package is later edited/deleted
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  package_name: { type: DataTypes.STRING, allowNull: false },
  package_duration: { type: DataTypes.STRING, allowNull: false }, // human label e.g. "1 Month"
  package_speed: { type: DataTypes.STRING, allowNull: false }, // e.g. "10/5 Mbps"
  payment_method: { type: DataTypes.STRING, allowNull: false }, // mpesa/cash/bank
  mpesa_receipt: { type: DataTypes.STRING },
  period_from: { type: DataTypes.DATE, allowNull: false },   // payment date
  period_to: { type: DataTypes.DATE, allowNull: false },   // expiry date

  status: {
    type: DataTypes.ENUM('issued', 'void'),
    defaultValue: 'issued',
  },
}, {
  tableName: 'Invoices',
});

const Setting = sequelize.define('Setting', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  category: { type: DataTypes.STRING(50), allowNull: false },
  key: { type: DataTypes.STRING(100), allowNull: false },
  value: { type: DataTypes.TEXT },
  is_secret: { type: DataTypes.BOOLEAN, defaultValue: false },
  label: { type: DataTypes.STRING },
}, {
  tableName: 'Settings'
});

// ─── Notifications ────────────────────────────────────────────────────────────
// Stores every notification fired by the system.
// recipient_type: 'admin'    → shown in admin bell (no recipient_id needed)
//                 'customer' → tied to a specific customer
// channels: which delivery methods were attempted (json array: ['sms','email','inapp'])
// read: only meaningful for in-app (admin bell) notifications
const Notification = sequelize.define('Notification', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

  // What event fired this
  event: {
    type: DataTypes.ENUM(
      'payment_received',
      'customer_created',
      'router_offline',
      'router_online'
    ),
    allowNull: false,
  },

  // Who sees it
  recipient_type: { type: DataTypes.ENUM('admin', 'customer'), allowNull: false },
  recipient_id: { type: DataTypes.UUID }, // customer UUID when recipient_type = 'customer'

  // Content
  title: { type: DataTypes.STRING, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },

  // Which channels were used
  channels: {
    type: DataTypes.JSON,  // e.g. ['sms', 'email', 'inapp']
    defaultValue: [],
  },

  // Delivery status per channel
  sms_status: { type: DataTypes.ENUM('sent', 'failed', 'skipped'), defaultValue: 'skipped' },
  email_status: { type: DataTypes.ENUM('sent', 'failed', 'skipped'), defaultValue: 'skipped' },

  // In-app read tracking (admin bell)
  read: { type: DataTypes.BOOLEAN, defaultValue: false },
  read_at: { type: DataTypes.DATE },

  // Optional reference to related entity
  ref_type: { type: DataTypes.STRING }, // 'payment', 'customer', 'router'
  ref_id: { type: DataTypes.STRING }, // UUID of the related record

}, { tableName: 'Notifications' });

// ─── Associations ─────────────────────────────────────────────────────────────
Customer.belongsTo(Package, { foreignKey: 'package_id' });
Customer.belongsTo(Router, { foreignKey: 'router_id' });
Package.hasMany(Customer, { foreignKey: 'package_id' });
Router.hasMany(Customer, { foreignKey: 'router_id' });

Payment.belongsTo(Customer, { foreignKey: 'customer_id' });
Payment.belongsTo(Package, { foreignKey: 'package_id' });
Customer.hasMany(Payment, { foreignKey: 'customer_id' });

Customer.hasMany(Session, { foreignKey: 'customer_id' });
Session.belongsTo(Customer, { foreignKey: 'customer_id' });

HotspotSession.belongsTo(Router, { foreignKey: 'router_id' });
HotspotSession.belongsTo(Customer, { foreignKey: 'customer_id' });
HotspotSession.belongsTo(Package, { foreignKey: 'package_id' });

Invoice.belongsTo(Customer, { foreignKey: 'customer_id' });
Invoice.belongsTo(Payment, { foreignKey: 'payment_id' });
Invoice.belongsTo(Package, { foreignKey: 'package_id' });
Customer.hasMany(Invoice, { foreignKey: 'customer_id' });
Payment.hasOne(Invoice, { foreignKey: 'payment_id' });

module.exports = {
  Admin, Package, Customer, Router,
  Payment, Session, HotspotSession,
  Invoice, Setting,
  sequelize, Notification
};