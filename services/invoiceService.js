/**
 * services/invoiceService.js
 *
 * Handles invoice creation and number generation.
 * Called from payments.js (activateCustomer) whenever a payment completes.
 */

const { Invoice, Customer, Payment, Package } = require('../models');
const { humanDuration } = require('../utils/duration');
const logger = require('../config/logger');

/**
 * generateInvoiceNumber()
 *
 * Format: INV-YYYYMM-NNNNN  (e.g. INV-202501-00042)
 * The sequence resets per month — NNNNN is the count of invoices this month + 1.
 * Padded to 5 digits so it looks clean and sorts correctly.
 */
const generateInvoiceNumber = async () => {
  const now    = new Date();
  const year   = now.getFullYear();
  const month  = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `INV-${year}${month}-`;

  const count = await Invoice.count({
    where: {
      invoice_number: { [require('sequelize').Op.like]: `${prefix}%` },
    },
  });

  const seq = String(count + 1).padStart(5, '0');
  return `${prefix}${seq}`;
};

/**
 * createInvoice(payment, customer, pkg)
 *
 * Creates an Invoice record snapshotting all details at the time of payment.
 * Idempotent — if an invoice already exists for this payment, returns it.
 *
 * @param {object} payment  — Payment DB record (status must be 'completed')
 * @param {object} customer — Customer DB record
 * @param {object} pkg      — Package DB record
 * @returns {Invoice}
 */
const createInvoice = async (payment, customer, pkg) => {
  // Idempotency — don't double-create if callback fires twice
  const existing = await Invoice.findOne({ where: { payment_id: payment.id } });
  if (existing) {
    logger.info(`Invoice already exists for payment ${payment.id}: ${existing.invoice_number}`);
    return existing;
  }

  const invoiceNumber = await generateInvoiceNumber();

  // Speed label e.g. "10 / 5 Mbps"
  const dl    = (pkg.speed_download / 1024).toFixed(0);
  const ul    = (pkg.speed_upload   / 1024).toFixed(0);
  const speed = `${dl} / ${ul} Mbps`;

  // Duration label e.g. "1 Month", "1 Hour"
  const duration = humanDuration(pkg);

  const invoice = await Invoice.create({
    invoice_number:   invoiceNumber,
    customer_id:      customer.id,
    payment_id:       payment.id,
    package_id:       pkg.id,
    amount:           payment.amount,
    package_name:     pkg.name,
    package_duration: duration,
    package_speed:    speed,
    payment_method:   payment.method,
    mpesa_receipt:    payment.mpesa_receipt || null,
    period_from:      payment.paid_at || new Date(),
    period_to:        customer.expiry_date,
    status:           'issued',
  });

  logger.info(`Invoice created: ${invoiceNumber} for customer ${customer.username}`);
  return invoice;
};

module.exports = { createInvoice, generateInvoiceNumber };