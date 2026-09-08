// Generates a billing invoice PDF — header, bill-to family, line items table,
// totals, and payment status. Mirrors the build-in-memory/return-a-Buffer
// pattern used by generateTimesheetPdf.js and generateAgreementPdf.js.
//
// Visual design matches the app's own forest-green/gold/birch palette (see
// dashboard.html :root) — a solid color header band, the actual logo, a gold
// accent stripe, a colored status badge, and a tinted totals box, rather than
// plain black-on-white text with only the headings in color.
const PDFDocument = require('pdfkit');
const https = require('https');

const LOGO_URL = 'https://res.cloudinary.com/dhlymdlu/image/upload/v1788058962/Screenshot_2026-08-04_at_8.42.07_PM.png';

// PDFKit's doc.image() needs an actual Buffer or local file path — it cannot
// fetch a remote URL itself. This downloads the logo once per PDF generation.
// If the fetch fails for any reason (network blip, Cloudinary hiccup), the
// invoice still generates — just without the logo — rather than failing the
// whole invoice send/download over a decorative image.
function fetchImageBuffer(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

const COLORS = {
  forestDeep: '#1B2E22',
  forestDark: '#12241A',
  gold: '#D9A441',
  goldDark: '#BF8A2E',
  birch: '#F4EDE0',
  wood: '#8B5E34',
  bark: '#3A2E22',
  moss: '#6B7A5E',
  sageLine: '#D6C9AD',
  success: '#4A7A5C',
  successBg: '#E7F1EA',
  error: '#B3462E',
  errorBg: '#FBEAE4',
  white: '#FFFFFF',
};

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
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 0 });
      const chunks = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width; // 612 for LETTER
      const marginX = 50;
      const contentWidth = pageWidth - marginX * 2;

      const logoBuffer = await fetchImageBuffer(LOGO_URL);

      // ---- Header band: solid forest green, full width, white text ----
      const headerHeight = 108;
      doc.rect(0, 0, pageWidth, headerHeight).fill(COLORS.forestDeep);
      // Thin gold accent stripe under the header — a small but real color
      // touch that echoes the gold accents used throughout the app.
      doc.rect(0, headerHeight, pageWidth, 4).fill(COLORS.gold);

      let brandTextX = marginX;
      if (logoBuffer) {
        const logoSize = 52;
        doc.image(logoBuffer, marginX, (headerHeight - logoSize) / 2, { width: logoSize, height: logoSize });
        brandTextX = marginX + logoSize + 14;
      }

      doc.fontSize(20).fillColor(COLORS.birch).text('The Little Playhut', brandTextX, 32);
      doc.fontSize(9).fillColor(COLORS.gold).text('PRESCHOOL & DAYCARE', brandTextX, 56, { characterSpacing: 0.5 });

      doc.fontSize(22).fillColor(COLORS.white).text('INVOICE', marginX, 30, { width: contentWidth, align: 'right' });
      doc.fontSize(10).fillColor(COLORS.birch).text(invoice.invoice_number, marginX, 58, { width: contentWidth, align: 'right' });

      // ---- Status badge, top right, rounded rect ----
      const isPaid = invoice.status === 'paid';
      const isVoid = invoice.status === 'void';
      const badgeColor = isPaid ? COLORS.success : isVoid ? COLORS.moss : COLORS.gold;
      const badgeText = isPaid ? `PAID${invoice.paid_at ? ' ' + formatDate(invoice.paid_at) : ''}` : isVoid ? 'VOID' : 'PAYMENT DUE';
      const badgeWidth = doc.fontSize(9).widthOfString(badgeText.toUpperCase()) + 24;
      const badgeX = pageWidth - marginX - badgeWidth;
      doc.roundedRect(badgeX, 78, badgeWidth, 18, 9).fill(badgeColor);
      doc.fontSize(9).fillColor(COLORS.white).text(badgeText.toUpperCase(), badgeX, 83, { width: badgeWidth, align: 'center', characterSpacing: 0.3 });

      let y = headerHeight + 30;

      // ---- Bill-to / dates row ----
      doc.fontSize(9).fillColor(COLORS.wood).text('BILL TO', marginX, y, { characterSpacing: 0.3 });
      doc.fontSize(12).fillColor(COLORS.bark).text(family.primary_parent_name, marginX, y + 14);
      let billToY = y + 30;
      if (family.mailing_address) {
        doc.fontSize(10).fillColor(COLORS.moss).text(family.mailing_address, marginX, billToY, { width: 260 });
        billToY = doc.y + 2;
      }
      doc.fontSize(10).fillColor(COLORS.moss).text(family.primary_parent_email, marginX, billToY);

      const datesX = 350;
      doc.fontSize(9).fillColor(COLORS.wood).text('INVOICE DATE', datesX, y, { width: contentWidth - (datesX - marginX), align: 'right', characterSpacing: 0.3 });
      doc.fontSize(11).fillColor(COLORS.bark).text(formatDate(invoice.invoice_date), datesX, y + 14, { width: contentWidth - (datesX - marginX), align: 'right' });
      doc.fontSize(9).fillColor(COLORS.wood).text('DUE DATE', datesX, y + 36, { width: contentWidth - (datesX - marginX), align: 'right', characterSpacing: 0.3 });
      doc.fontSize(11).fillColor(COLORS.bark).text(formatDate(invoice.due_date), datesX, y + 50, { width: contentWidth - (datesX - marginX), align: 'right' });

      y = Math.max(doc.y, y + 90) + 20;

      // ---- Line items table ----
      const col = { desc: marginX, qty: 350, price: 420, total: 490 };
      const tableRight = marginX + contentWidth;

      // Header row: sage/tan background band, wood-brown text
      doc.rect(marginX, y, contentWidth, 24).fill(COLORS.sageLine);
      doc.fontSize(9).fillColor(COLORS.bark);
      doc.text('DESCRIPTION', col.desc + 10, y + 8, { characterSpacing: 0.3 });
      doc.text('QTY', col.qty, y + 8, { width: 50, align: 'right', characterSpacing: 0.3 });
      doc.text('PRICE', col.price, y + 8, { width: 60, align: 'right', characterSpacing: 0.3 });
      doc.text('TOTAL', col.total - 10, y + 8, { width: 70, align: 'right', characterSpacing: 0.3 });
      y += 24;

      // Alternating row backgrounds for readability, echoing the app's own
      // table striping conventions.
      doc.fontSize(10).fillColor(COLORS.bark);
      lineItems.forEach((item, i) => {
        const rowHeight = 22;
        if (i % 2 === 1) doc.rect(marginX, y, contentWidth, rowHeight).fill(COLORS.birch);
        doc.fillColor(COLORS.bark);
        doc.text(item.description, col.desc + 10, y + 6, { width: 290 });
        doc.text(String(item.quantity || 1), col.qty, y + 6, { width: 50, align: 'right' });
        doc.text(formatMoney(item.unit_price), col.price, y + 6, { width: 60, align: 'right' });
        doc.text(formatMoney(item.line_total), col.total - 10, y + 6, { width: 70, align: 'right' });
        y += rowHeight;
      });

      doc.moveTo(marginX, y + 2).lineTo(tableRight, y + 2).strokeColor(COLORS.sageLine).lineWidth(1).stroke();
      y += 18;

      // ---- Totals box: birch background, right-aligned ----
      const boxWidth = 220;
      const boxX = tableRight - boxWidth;
      let boxLines = 1; // subtotal always shown
      if (Number(invoice.adjustments_total) !== 0) boxLines++;
      if (Number(invoice.tax_total) !== 0) boxLines++;
      const boxHeight = boxLines * 20 + 46; // + total row + padding
      doc.roundedRect(boxX, y, boxWidth, boxHeight, 8).fill(COLORS.birch);

      let rowY = y + 14;
      const labelX = boxX + 16;
      const valueWidth = boxWidth - 32;
      doc.fontSize(10).fillColor(COLORS.bark);
      doc.text('Subtotal', labelX, rowY, { width: valueWidth / 2 });
      doc.text(formatMoney(invoice.subtotal), labelX + valueWidth / 2, rowY, { width: valueWidth / 2, align: 'right' });
      rowY += 20;
      if (Number(invoice.adjustments_total) !== 0) {
        doc.text('Adjustments', labelX, rowY, { width: valueWidth / 2 });
        doc.text(formatMoney(invoice.adjustments_total), labelX + valueWidth / 2, rowY, { width: valueWidth / 2, align: 'right' });
        rowY += 20;
      }
      if (Number(invoice.tax_total) !== 0) {
        doc.text('Tax', labelX, rowY, { width: valueWidth / 2 });
        doc.text(formatMoney(invoice.tax_total), labelX + valueWidth / 2, rowY, { width: valueWidth / 2, align: 'right' });
        rowY += 20;
      }

      doc.moveTo(labelX, rowY + 2).lineTo(boxX + boxWidth - 16, rowY + 2).strokeColor(COLORS.wood).lineWidth(1).stroke();
      rowY += 12;
      doc.fontSize(13).fillColor(COLORS.forestDeep).text('Total Due', labelX, rowY, { width: valueWidth / 2 });
      doc.fontSize(13).fillColor(COLORS.forestDeep).text(formatMoney(invoice.grand_total), labelX + valueWidth / 2, rowY, { width: valueWidth / 2, align: 'right' });

      // ---- Footer band ----
      const footerY = doc.page.height - 60;
      doc.rect(0, footerY, pageWidth, 60).fill(COLORS.forestDeep);
      doc.fontSize(9).fillColor(COLORS.gold).text(
        'The Little Playhut Preschool & Daycare — thank you for your enrollment!',
        marginX, footerY + 24, { width: contentWidth, align: 'center' }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateInvoicePdf };
