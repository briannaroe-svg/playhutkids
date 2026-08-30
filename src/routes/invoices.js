const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const Stripe = require('stripe');
const { requireAdmin } = require('../middleware/auth');
const { generateInvoicePdf } = require('../utils/generateInvoicePdf');
const { uploadPdfBuffer } = require('../utils/cloudinary');
const { sendEmail } = require('../utils/email');

router.use(requireAdmin);

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Shared helper: load an invoice + its line items + the billed family, in the
// shape generateInvoicePdf expects. Used by both the PDF and email routes
// below so they can't drift out of sync with each other.
async function loadInvoiceForPdf(invoiceId) {
  const invoiceResult = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
  if (invoiceResult.rows.length === 0) return null;
  const invoice = invoiceResult.rows[0];

  const [lineItemsResult, familyResult] = await Promise.all([
    pool.query(`SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY line_number`, [invoiceId]),
    pool.query(`SELECT * FROM families WHERE id = $1`, [invoice.family_id]),
  ]);

  return { invoice, lineItems: lineItemsResult.rows, family: familyResult.rows[0] };
}

// GET /invoices/:id/pdf — generates the invoice PDF, uploads it to Cloudinary,
// saves the URL on the invoice (pdf_url), and returns it. Regenerates every
// call rather than trusting a stale pdf_url, since an invoice's line items or
// payment status can change after the first PDF was made — the "Download
// PDF" / "Print" buttons should always reflect the invoice as it stands now.
router.get('/:id(\\d+)/pdf', async (req, res) => {
  try {
    const data = await loadInvoiceForPdf(req.params.id);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    if (!data.family) return res.status(404).json({ error: 'The family this invoice is billed to no longer exists' });

    const pdfBuffer = await generateInvoicePdf(data);
    const pdfUrl = await uploadPdfBuffer(
      pdfBuffer,
      `invoice-${data.invoice.invoice_number}`,
      'little-playhut/invoices'
    );

    await pool.query(`UPDATE invoices SET pdf_url = $2, updated_at = now() WHERE id = $1`, [req.params.id, pdfUrl]);

    res.json({ pdf_url: pdfUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
});

// POST /invoices/:id/send-email — generates a fresh PDF (see note above) and
// emails it to the family's primary_parent_email as an attachment.
router.post('/:id(\\d+)/send-email', async (req, res) => {
  try {
    const data = await loadInvoiceForPdf(req.params.id);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    if (!data.family) return res.status(404).json({ error: 'The family this invoice is billed to no longer exists' });
    if (!data.family.primary_parent_email) return res.status(400).json({ error: 'This family has no email on file' });

    const pdfBuffer = await generateInvoicePdf(data);
    const pdfUrl = await uploadPdfBuffer(
      pdfBuffer,
      `invoice-${data.invoice.invoice_number}`,
      'little-playhut/invoices'
    );
    await pool.query(`UPDATE invoices SET pdf_url = $2, updated_at = now() WHERE id = $1`, [req.params.id, pdfUrl]);

    const grandTotal = Number(data.invoice.grand_total).toFixed(2);
    const sent = await sendEmail({
      to: [data.family.primary_parent_email],
      subject: `Invoice ${data.invoice.invoice_number} from The Little Playhut`,
      html: `
        <p>Hi ${data.family.primary_parent_name},</p>
        <p>Please find attached invoice <strong>${data.invoice.invoice_number}</strong> for <strong>$${grandTotal}</strong>, due ${data.invoice.due_date ? new Date(data.invoice.due_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'upon receipt'}.</p>
        <p>Thank you!<br>The Little Playhut</p>
      `,
      attachments: [
        { filename: `Invoice-${data.invoice.invoice_number}.pdf`, content: pdfBuffer, contentType: 'application/pdf' },
      ],
    });

    if (!sent) {
      return res.status(502).json({ error: 'The PDF was generated, but the email could not be sent. Email may not be configured yet — check EMAIL_USER/EMAIL_PASS.' });
    }

    res.json({ sent: true, pdf_url: pdfUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to email invoice' });
  }
});

// GET /invoices/tax-report — must be mounted BEFORE /:id (KP's lesson: route order matters)
router.get('/tax-report', async (req, res) => {
  const { year } = req.query;
  const y = year || new Date().getFullYear();
  try {
    const result = await pool.query(
      `SELECT SUM(tax_total) AS total_tax, SUM(grand_total) AS total_revenue
       FROM invoices WHERE status = 'paid' AND EXTRACT(YEAR FROM invoice_date) = $1`,
      [y]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate tax report' });
  }
});

router.get('/', async (req, res) => {
  const { status, family_id } = req.query;
  try {
    let query = `
      SELECT i.*, f.primary_parent_name,
        (f.card_brand IS NOT NULL) AS has_card_on_file
      FROM invoices i
      JOIN families f ON i.family_id = f.id
      WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); query += ` AND i.status = $${params.length}`; }
    if (family_id) { params.push(family_id); query += ` AND i.family_id = $${params.length}`; }
    query += ` ORDER BY i.invoice_date DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const invoice = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [req.params.id]);
    if (invoice.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const items = await pool.query(
      `SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY line_number`,
      [req.params.id]
    );
    res.json({ ...invoice.rows[0], line_items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// POST /invoices — create invoice with line items in one transaction
router.post('/', async (req, res) => {
  const { family_id, invoice_number, due_date, line_items, tax_total } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const subtotal = line_items.reduce((sum, li) => sum + Number(li.line_total), 0);
    const grand_total = subtotal + Number(tax_total || 0);

    const invoiceResult = await client.query(
      `INSERT INTO invoices (invoice_number, family_id, due_date, subtotal, tax_total, grand_total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [invoice_number, family_id, due_date, subtotal, tax_total || 0, grand_total]
    );
    const invoice = invoiceResult.rows[0];

    for (let i = 0; i < line_items.length; i++) {
      const li = line_items[i];
      await client.query(
        `INSERT INTO invoice_line_items
          (invoice_id, child_id, line_number, description, item_type, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [invoice.id, li.child_id || null, i + 1, li.description, li.item_type, li.quantity, li.unit_price, li.line_total]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(invoice);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create invoice' });
  } finally {
    client.release();
  }
});

// POST /invoices/:id/payment-link — create a Stripe Payment Link for this invoice
router.post('/:id(\\d+)/payment-link', async (req, res) => {
  try {
    const invoice = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [req.params.id]);
    if (invoice.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const inv = invoice.rows[0];

    // Stripe amounts are in cents
    const amountCents = Math.round(Number(inv.grand_total) * 100);

    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: amountCents,
      product_data: { name: `Invoice ${inv.invoice_number}` },
    });

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { invoice_id: String(inv.id), invoice_number: inv.invoice_number },
      // metadata on the Payment Link itself does NOT carry over to the PaymentIntent
      // created when someone pays — payment_intent_data.metadata is what the webhook
      // handler (src/routes/webhooks.js) actually reads from payment_intent.succeeded.
      payment_intent_data: {
        metadata: { invoice_id: String(inv.id), invoice_number: inv.invoice_number },
      },
    });

    await pool.query(
      `UPDATE invoices SET stripe_payment_link_url = $1, status = 'sent', updated_at = now() WHERE id = $2`,
      [paymentLink.url, inv.id]
    );

    res.json({ payment_link_url: paymentLink.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create Stripe payment link' });
  }
});

// POST /invoices/:id/mark-paid — manual mark (cash/check) or called from a Stripe webhook handler
router.post('/:id(\\d+)/mark-paid', async (req, res) => {
  const { payment_method } = req.body;
  try {
    const result = await pool.query(
      `UPDATE invoices SET status = 'paid', payment_method = $2, paid_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, payment_method]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark invoice paid' });
  }
});

// POST /invoices/:id/charge-card — charge the family's saved card for this
// invoice's grand_total, and mark it paid on success. This is an off-session
// charge (the family isn't present at a checkout flow — admin is initiating
// it on their behalf using a card saved earlier), which is exactly what
// Stripe's off_session flag exists for. Declines and other card errors are
// surfaced with Stripe's own message rather than a generic failure, since
// "insufficient funds" vs "card expired" vs "call your bank" all need
// different follow-up from admin.
router.post('/:id(\\d+)/charge-card', async (req, res) => {
  try {
    const invoiceResult = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [req.params.id]);
    if (invoiceResult.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = invoiceResult.rows[0];

    if (invoice.status === 'paid') return res.status(400).json({ error: 'This invoice is already paid' });
    if (invoice.status === 'void') return res.status(400).json({ error: 'This invoice has been voided' });

    const familyResult = await pool.query(`SELECT * FROM families WHERE id = $1`, [invoice.family_id]);
    const family = familyResult.rows[0];
    if (!family || !family.stripe_customer_id || !family.card_brand) {
      return res.status(400).json({ error: 'This family has no saved card on file' });
    }

    const customer = await stripe.customers.retrieve(family.stripe_customer_id);
    const paymentMethodId = customer.invoice_settings?.default_payment_method;
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'No default payment method found on this card — try re-adding the card' });
    }

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(Number(invoice.grand_total) * 100), // Stripe expects cents
        currency: 'usd',
        customer: family.stripe_customer_id,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: `Invoice ${invoice.invoice_number} — The Little Playhut`,
        metadata: { invoice_id: String(invoice.id), invoice_number: invoice.invoice_number },
      });
    } catch (stripeErr) {
      // Stripe card errors (declined, expired, etc.) land here, distinct from
      // a genuine server/network failure — surface Stripe's own message.
      if (stripeErr.type === 'StripeCardError') {
        return res.status(402).json({ error: stripeErr.message || 'The card was declined.' });
      }
      throw stripeErr;
    }

    if (paymentIntent.status !== 'succeeded') {
      return res.status(402).json({ error: `Charge did not complete (status: ${paymentIntent.status}). No payment was recorded.` });
    }

    const result = await pool.query(
      `UPDATE invoices SET status = 'paid', payment_method = 'card', stripe_payment_intent_id = $2, paid_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, paymentIntent.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to charge card: ' + err.message });
  }
});

module.exports = router;
