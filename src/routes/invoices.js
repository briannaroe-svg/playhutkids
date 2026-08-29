const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const Stripe = require('stripe');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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
    let query = `SELECT * FROM invoices WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    if (family_id) { params.push(family_id); query += ` AND family_id = $${params.length}`; }
    query += ` ORDER BY invoice_date DESC`;
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

module.exports = router;
