/**
 * routes/invoices.js
 *
 * GET  /api/invoices              — list invoices (filterable by customer_id)
 * GET  /api/invoices/:id          — get single invoice with full detail
 * GET  /api/invoices/:id/pdf      — stream a PDF of the invoice
 * POST /api/invoices/:id/void     — void an invoice (superadmin only)
 */

const express = require('express');
const { Op }  = require('sequelize');
const { Invoice, Customer, Payment, Package } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();
// router.use(authenticate);

// ── GET /api/invoices ─────────────────────────────────────────────────────────
router.get('/', authenticate,  async (req, res, next) => {
  try {
    const { customer_id, status, page = 1, limit = 20 } = req.query;
    const where = {};
    if (customer_id) where.customer_id = customer_id;
    if (status)      where.status      = status;

    const offset = (Number(page) - 1) * Number(limit);
    const { count, rows } = await Invoice.findAndCountAll({
      where,
      include: [
        { model: Customer, attributes: ['id', 'full_name', 'phone', 'username'] },
        { model: Payment,  attributes: ['id', 'method', 'mpesa_receipt', 'paid_at'] },
      ],
      order:  [['createdAt', 'DESC']],
      limit:  Number(limit),
      offset,
    });

    return res.paginated(rows, count, page, limit);
  } catch (err) { next(err); }
});

// ── GET /api/invoices/:id ─────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const invoice = await Invoice.findByPk(req.params.id, {
      include: [
        { model: Customer, attributes: ['id', 'full_name', 'phone', 'email', 'username'] },
        { model: Payment,  attributes: ['id', 'method', 'mpesa_receipt', 'paid_at', 'amount'] },
      ],
    });
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
    return res.success(invoice);
  } catch (err) { next(err); }
});

// ── GET /api/invoices/:id/pdf ─────────────────────────────────────────────────
// Streams a clean PDF invoice directly to the browser/client.
// No temp files — PDFKit pipes straight into the response stream.
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const invoice = await Invoice.findByPk(req.params.id, {
      include: [
        { model: Customer, attributes: ['full_name', 'phone', 'email', 'username'] },
      ],
    });

    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type',        'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
    doc.pipe(res);

    // ── Colours & helpers ───────────────────────────────────────────────────
    const PRIMARY  = '#2563eb';
    const DARK     = '#0f172a';
    const MUTED    = '#64748b';
    const LIGHT_BG = '#f8fafc';
    const BORDER   = '#e2e8f0';

    const W = doc.page.width  - 100; // usable width (margin 50 each side)
    const fmtKES = (n) => `KES ${Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-KE', {
      day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi'
    }) : '—';

    // ── Header band ─────────────────────────────────────────────────────────
    doc.rect(50, 45, W, 70).fill(PRIMARY);

    // ISP name (left)
    doc.fillColor('white')
       .font('Helvetica-Bold').fontSize(20)
       .text(process.env.APP_NAME || 'ISP Billing', 65, 63);

    doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.75)')
       .text('Internet Service Provider', 65, 87);

    // INVOICE label (right)
    doc.font('Helvetica-Bold').fontSize(26).fillColor('white')
       .text('INVOICE', 0, 60, { align: 'right', width: W + 50 });

    doc.fillColor(DARK);

    // ── Invoice meta (below header) ──────────────────────────────────────────
    const metaY = 135;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED)
       .text('INVOICE NUMBER',  65,  metaY)
       .text('DATE ISSUED',     230, metaY)
       .text('STATUS',          395, metaY);

    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK)
       .text(invoice.invoice_number,             65,  metaY + 14)
       .text(fmtDate(invoice.createdAt),         230, metaY + 14);

    // Status badge
    const statusColor = invoice.status === 'void' ? '#dc2626' : '#16a34a';
    doc.roundedRect(395, metaY + 10, 65, 20, 4).fill(statusColor);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('white')
       .text(invoice.status.toUpperCase(), 395, metaY + 15, { width: 65, align: 'center' });

    doc.fillColor(DARK);

    // ── Bill To / Bill From ──────────────────────────────────────────────────
    const addrY = 195;
    doc.rect(50, addrY, W, 80).fill(LIGHT_BG).stroke(BORDER);

    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
       .text('BILL TO', 65, addrY + 12)
       .text('FROM', 320, addrY + 12);

    const c = invoice.Customer;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK)
       .text(c?.full_name || '—', 65, addrY + 26);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(c?.phone    || '',    65, addrY + 42)
       .text(c?.email    || '',    65, addrY + 55)
       .text(`@${c?.username || ''}`, 65, addrY + 68);

    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK)
       .text(process.env.APP_NAME || 'ISP Billing', 320, addrY + 26);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(process.env.COMPANY_EMAIL  || 'billing@isp.co.ke', 320, addrY + 42)
       .text(process.env.COMPANY_PHONE  || '+254 700 000 000',  320, addrY + 55)
       .text(process.env.COMPANY_ADDRESS|| 'Nairobi, Kenya',    320, addrY + 68);

    doc.fillColor(DARK);

    // ── Line items table ─────────────────────────────────────────────────────
    const tableY = 300;

    // Header row
    doc.rect(50, tableY, W, 24).fill(DARK);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('white')
       .text('DESCRIPTION',  65,  tableY + 8)
       .text('PERIOD FROM',  240, tableY + 8)
       .text('PERIOD TO',    355, tableY + 8)
       .text('AMOUNT',       460, tableY + 8, { width: 80, align: 'right' });

    doc.fillColor(DARK);

    // Item row
    const rowY = tableY + 24;
    doc.rect(50, rowY, W, 50).fill(LIGHT_BG).stroke(BORDER);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK)
       .text(invoice.package_name, 65, rowY + 10);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(`${invoice.package_duration}  ·  ${invoice.package_speed}`, 65, rowY + 25);

    doc.font('Helvetica').fontSize(9).fillColor(DARK)
       .text(fmtDate(invoice.period_from), 240, rowY + 17)
       .text(fmtDate(invoice.period_to),   355, rowY + 17);

    doc.font('Helvetica-Bold').fontSize(11).fillColor(PRIMARY)
       .text(fmtKES(invoice.amount), 460, rowY + 15, { width: 80, align: 'right' });

    // ── Total row ────────────────────────────────────────────────────────────
    const totalY = rowY + 50;
    doc.rect(50, totalY, W, 36).fill(PRIMARY);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('white')
       .text('TOTAL', 65, totalY + 11)
       .text(fmtKES(invoice.amount), 460, totalY + 11, { width: 80, align: 'right' });

    // ── Payment details ──────────────────────────────────────────────────────
    const payY = totalY + 56;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('PAYMENT DETAILS', 65, payY);
    doc.moveTo(65, payY + 13).lineTo(W + 50, payY + 13).stroke(BORDER);

    const payDetails = [
      ['Method',       invoice.payment_method?.toUpperCase()],
      invoice.mpesa_receipt ? ['M-Pesa Receipt', invoice.mpesa_receipt] : null,
      ['Payment Date', fmtDate(invoice.period_from)],
    ].filter(Boolean);

    payDetails.forEach(([label, value], i) => {
      const y = payY + 22 + i * 18;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label + ':', 65, y);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text(value, 200, y);
    });

    // ── Footer ───────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 80;
    doc.moveTo(50, footerY).lineTo(W + 50, footerY).stroke(BORDER);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text(
         `Thank you for using ${process.env.APP_NAME || 'ISP Billing'}. For support, contact ${process.env.COMPANY_EMAIL || 'support@isp.co.ke'}`,
         50, footerY + 12, { align: 'center', width: W }
       )
       .text(
         `This is a computer-generated invoice and does not require a signature.`,
         50, footerY + 26, { align: 'center', width: W }
       );

    doc.end();
  } catch (err) {
    if (!res.headersSent) next(err);
    else logger.error('PDF generation error (headers already sent):', err);
  }
});

// ── POST /api/invoices ────────────────────────────────────────────────────────
// Manually create an invoice — for cases where admin needs to issue an invoice
// without going through the payment flow (e.g. bank transfer, credit, correction).
// A Payment record is also created in 'completed' state to keep the audit trail.
router.post(
  '/',
  [authenticate, authorize('admin', 'superadmin')],
  async (req, res, next) => {
    try {
      const {
        customer_id,
        package_id,
        amount,
        payment_method = 'manual',
        mpesa_receipt,
        period_from,
        period_to,
        notes,
      } = req.body;

      // Validate required fields
      if (!customer_id) return res.status(400).json({ success: false, message: 'customer_id is required' });
      if (!package_id)  return res.status(400).json({ success: false, message: 'package_id is required' });
      if (!amount || isNaN(Number(amount)) || Number(amount) < 0)
        return res.status(400).json({ success: false, message: 'Valid amount is required' });
      if (!period_from || !period_to)
        return res.status(400).json({ success: false, message: 'period_from and period_to are required' });

      const customer = await Customer.findByPk(customer_id);
      if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

      const pkg = await Package.findByPk(package_id);
      if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });

      // Create a companion Payment record for the audit trail
      const payment = await Payment.create({
        customer_id,
        package_id,
        amount:   Number(amount),
        method:   payment_method,
        status:   'completed',
        source:   'admin',
        mpesa_receipt: mpesa_receipt || null,
        notes:    notes || `Manual invoice created by admin ${req.admin.id}`,
        paid_at:  new Date(period_from),
      });

      // Build invoice directly (bypass createInvoice helper so we can override period dates)
      const { generateInvoiceNumber } = require('../services/invoiceService');
      const { humanDuration }         = require('../utils/duration');

      const invoiceNumber = await generateInvoiceNumber();
      const dl    = (pkg.speed_download / 1024).toFixed(0);
      const ul    = (pkg.speed_upload   / 1024).toFixed(0);

      const invoice = await Invoice.create({
        invoice_number:   invoiceNumber,
        customer_id,
        payment_id:       payment.id,
        package_id,
        amount:           Number(amount),
        package_name:     pkg.name,
        package_duration: humanDuration(pkg),
        package_speed:    `${dl} / ${ul} Mbps`,
        payment_method,
        mpesa_receipt:    mpesa_receipt || null,
        period_from:      new Date(period_from),
        period_to:        new Date(period_to),
        status:           'issued',
      });

      logger.info(`Manual invoice ${invoiceNumber} created by admin ${req.admin.id} for customer ${customer.username}`);
      return res.success(invoice, 'Invoice created', 201);
    } catch (err) { next(err); }
  }
);


router.post('/:id/void', [authenticate, authorize('superadmin')], async (req, res, next) => {
  try {
    const invoice = await Invoice.findByPk(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
    if (invoice.status === 'void') return res.status(400).json({ success: false, message: 'Invoice already voided' });
    await invoice.update({ status: 'void' });
    logger.info(`Invoice ${invoice.invoice_number} voided by admin ${req.admin.id}`);
    return res.success(invoice, 'Invoice voided');
  } catch (err) { next(err); }
});

module.exports = router;