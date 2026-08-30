// Generates a billing invoice PDF — header, bill-to family, line items table,
// totals, and payment status. Mirrors the build-in-memory/return-a-Buffer
// pattern used by generateTimesheetPdf.js and generateAgreementPdf.js.
const PDFDocument = require('pdfkit');

const formatMoney = (n) => `$${Number(n || 0).toFixed(2)}`;
const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—';

/**
 * @param {object} params
 * @param {object} params.invoice - row from `invoices` (invoice_number, invoice_date, due_date, subtotal, tax_total, grand_total, status, paid_at, ...)
 * @param {Array} params.lineItems - rows from `invoice_line_items` (description, quantity, unit_price, line_total)
 * @param {object} params.family - row from `families` (primary_parent_name, primary_parent_email, mailing_address)
 * @returns {Promise<Buffer>}
 */
function generateInvoicePdf({ invoice, lineItems, family }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ---- Header ----
    doc.fontSize(20).fillColor('#1B2E22').text('The Little Playhut', { align: 'left' });
    doc.fontSize(9).fillColor('#6B7A5E').text('Preschool & Daycare', { align: 'left' });
    doc.moveUp(2);
    doc.fontSize(20).fillColor('#1B2E22').text('INVOICE', { align: 'right' });
    doc.fontSize(10).fillColor('#3A2E22').text(invoice.invoice_number, { align: 'right' });
    doc.moveDown(1.5);

    // ---- Bill-to / dates row ----
    const infoTop = doc.y;
    doc.fontSize(9).fillColor('#8B5E34').text('BILL TO', 50, infoTop);
    doc.fontSize(11).fillColor('#000000').text(family.primary_parent_name, 50, infoTop + 14);
    if (family.mailing_address) doc.fontSize(10).fillColor('#3A2E22').text(family.mailing_address, 50, doc.y + 2, { width: 250 });
    doc.fontSize(10).fillColor('#3A2E22').text(family.primary_parent_email, 50, doc.y + 2);

    doc.fontSize(9).fillColor('#8B5E34').text('INVOICE DATE', 350, infoTop, { width: 200, align: 'right' });
    doc.fontSize(10).fillColor('#000000').text(formatDate(invoice.invoice_date), 350, infoTop + 12, { width: 200, align: 'right' });
    doc.fontSize(9).fillColor('#8B5E34').text('DUE DATE', 350, infoTop + 32, { width: 200, align: 'right' });
    doc.fontSize(10).fillColor('#000000').text(formatDate(invoice.due_date), 350, infoTop + 44, { width: 200, align: 'right' });

    doc.moveDown(3);
    doc.y = Math.max(doc.y, infoTop + 90);

    // ---- Line items table ----
    const tableTop = doc.y + 10;
    const col = { desc: 50, qty: 350, price: 420, total: 490 };

    doc.fontSize(9).fillColor('#8B5E34');
    doc.text('DESCRIPTION', col.desc, tableTop);
    doc.text('QTY', col.qty, tableTop, { width: 50, align: 'right' });
    doc.text('PRICE', col.price, tableTop, { width: 60, align: 'right' });
    doc.text('TOTAL', col.total, tableTop, { width: 70, align: 'right' });
    doc.moveTo(50, tableTop + 14).lineTo(560, tableTop + 14).strokeColor('#EDE6D6').stroke();

    let rowY = tableTop + 22;
    doc.fontSize(10).fillColor('#000000');
    for (const item of lineItems) {
      doc.text(item.description, col.desc, rowY, { width: 290 });
      doc.text(String(item.quantity || 1), col.qty, rowY, { width: 50, align: 'right' });
      doc.text(formatMoney(item.unit_price), col.price, rowY, { width: 60, align: 'right' });
      doc.text(formatMoney(item.line_total), col.total, rowY, { width: 70, align: 'right' });
      rowY += 20;
    }

    doc.moveTo(50, rowY + 4).lineTo(560, rowY + 4).strokeColor('#EDE6D6').stroke();
    rowY += 16;

    // ---- Totals ----
    const totalsX = 400;
    doc.fontSize(10).fillColor('#3A2E22');
    doc.text('Subtotal', totalsX, rowY, { width: 90 });
    doc.text(formatMoney(invoice.subtotal), totalsX + 90, rowY, { width: 70, align: 'right' });
    rowY += 16;
    if (Number(invoice.adjustments_total) !== 0) {
      doc.text('Adjustments', totalsX, rowY, { width: 90 });
      doc.text(formatMoney(invoice.adjustments_total), totalsX + 90, rowY, { width: 70, align: 'right' });
      rowY += 16;
    }
    if (Number(invoice.tax_total) !== 0) {
      doc.text('Tax', totalsX, rowY, { width: 90 });
      doc.text(formatMoney(invoice.tax_total), totalsX + 90, rowY, { width: 70, align: 'right' });
      rowY += 16;
    }
    doc.moveTo(totalsX, rowY + 2).lineTo(560, rowY + 2).strokeColor('#3A2E22').stroke();
    rowY += 10;
    doc.fontSize(13).fillColor('#1B2E22').text('Total Due', totalsX, rowY, { width: 90 });
    doc.text(formatMoney(invoice.grand_total), totalsX + 90, rowY, { width: 70, align: 'right' });
    rowY += 26;

    // ---- Payment status ----
    const isPaid = invoice.status === 'paid';
    doc.fontSize(11).fillColor(isPaid ? '#4A7A5C' : '#B3462E')
      .text(isPaid ? `PAID${invoice.paid_at ? ' — ' + formatDate(invoice.paid_at) : ''}` : 'PAYMENT DUE', totalsX, rowY, { width: 160, align: 'right' });

    // ---- Footer ----
    doc.fontSize(8).fillColor('#8B5E34').text(
      'The Little Playhut Preschool & Daycare — thank you for your enrollment!',
      50, 730, { width: 510, align: 'center' }
    );

    doc.end();
  });
}

module.exports = { generateInvoicePdf };
