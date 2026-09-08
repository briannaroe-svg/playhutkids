const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const Stripe = require('stripe');
const { requireAdmin } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// POST /recurring-plans/run-due is deliberately NOT behind requireAdmin —
// it's meant to be called once a day by an external scheduler (Render Cron
// Job, cron-job.org, etc.) that has no staff login of its own. It's
// protected instead by a shared secret, RECURRING_BILLING_SECRET, passed as
// a header — same pattern as BOOTSTRAP_SECRET elsewhere in this app. This
// route MUST be declared before router.use(requireAdmin) below, or the
// admin-auth middleware would apply to it too.
router.post('/run-due', async (req, res) => {
  const providedSecret = req.headers['x-recurring-billing-secret'];
  if (!process.env.RECURRING_BILLING_SECRET || providedSecret !== process.env.RECURRING_BILLING_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing secret' });
  }

  const today = new Date();
  const todayDay = today.getDate();
  const runDate = today.toISOString().slice(0, 10);

  try {
    const duePlans = await pool.query(
      `SELECT rp.*, f.primary_parent_name, f.stripe_customer_id, f.card_brand
       FROM recurring_plans rp
       JOIN families f ON rp.family_id = f.id
       WHERE rp.is_active = true AND rp.billing_day = $1
         AND NOT EXISTS (
           SELECT 1 FROM recurring_plan_runs
           WHERE recurring_plan_id = rp.id AND run_date = $2
         )`,
      [todayDay, runDate]
    );

    const results = [];
    for (const plan of duePlans.rows) {
      results.push(await runOnePlan(plan, runDate));
    }

    res.json({ checked: duePlans.rows.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run due recurring plans' });
  }
});

// Everything below this line requires a real admin login.
router.use(requireAdmin);

// ============================================================
// PLAN MANAGEMENT
// ============================================================

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rp.*, f.primary_parent_name, (f.card_brand IS NOT NULL) AS has_card_on_file
       FROM recurring_plans rp JOIN families f ON rp.family_id = f.id
       ORDER BY rp.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch recurring plans' });
  }
});

router.post('/', async (req, res) => {
  const { family_id, line_items, billing_day } = req.body;
  if (!family_id || !line_items || !line_items.length || !billing_day) {
    return res.status(400).json({ error: 'family_id, line_items, and billing_day are required' });
  }
  if (billing_day < 1 || billing_day > 28) {
    return res.status(400).json({ error: 'billing_day must be between 1 and 28' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO recurring_plans (family_id, line_items, billing_day, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [family_id, JSON.stringify(line_items), billing_day, req.staff.staff_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create recurring plan' });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  const { line_items, billing_day, is_active } = req.body;
  const updates = [];
  const values = [];
  let i = 2;

  if (line_items !== undefined) { updates.push(`line_items = $${i++}`); values.push(JSON.stringify(line_items)); }
  if (billing_day !== undefined) {
    if (billing_day < 1 || billing_day > 28) return res.status(400).json({ error: 'billing_day must be between 1 and 28' });
    updates.push(`billing_day = $${i++}`); values.push(billing_day);
  }
  if (is_active !== undefined) { updates.push(`is_active = $${i++}`); values.push(is_active); }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields provided to update' });

  try {
    const result = await pool.query(
      `UPDATE recurring_plans SET ${updates.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Recurring plan not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update recurring plan' });
  }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM recurring_plans WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Recurring plan not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete recurring plan' });
  }
});

// GET /recurring-plans/stripe-subscriptions — admin only, live list of active
// Stripe Subscriptions for review before importing. Flags whether a family
// with the same email already exists in this app, so admin can see at a
// glance which imports will create a new family vs. attach to an existing one.
router.get('/stripe-subscriptions', requireAdmin, async (req, res) => {
  try {
    const subscriptions = await stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      expand: ['data.customer', 'data.items.data.price'],
    });

    const results = [];
    for (const sub of subscriptions.data) {
      const customer = sub.customer;
      if (!customer || customer.deleted) continue; // skip subscriptions on deleted customers

      const item = sub.items.data[0];
      const price = item?.price;
      const amount = price ? Number(price.unit_amount) / 100 : null;
      const interval = price?.recurring?.interval || null;

      const existingFamily = await pool.query(
        `SELECT id, primary_parent_name FROM families WHERE primary_parent_email = $1`,
        [customer.email]
      );

      results.push({
        subscription_id: sub.id,
        customer_id: customer.id,
        customer_name: customer.name || '(no name on Stripe)',
        customer_email: customer.email || null,
        amount,
        interval,
        description: price?.product ? null : (item?.description || sub.description || null),
        existing_family_id: existingFamily.rows[0]?.id || null,
        existing_family_name: existingFamily.rows[0]?.primary_parent_name || null,
      });
    }

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch Stripe subscriptions: ' + err.message });
  }
});

// POST /recurring-plans/import-from-stripe — admin only. Migrates ONE active
// Stripe Subscription into this app's own recurring_plans system:
//   1. Finds or creates the family (matched by email)
//   2. Attaches the Subscription's Stripe Customer + its default payment
//      method as that family's saved card, so this app's own billing can
//      charge it later — no need to ask the parent to re-enter a card
//   3. Creates the recurring_plans row with the same amount/day
//   4. Cancels the Stripe Subscription, since this app's own billing now
//      owns future charges — leaving both running would double-bill the family
// Steps happen in this order deliberately: the Subscription is only
// cancelled LAST, after everything else has succeeded, so a failure partway
// through never leaves a family with no billing at all.
router.post('/import-from-stripe', requireAdmin, async (req, res) => {
  const { subscription_id, billing_day } = req.body;
  if (!subscription_id || !billing_day) {
    return res.status(400).json({ error: 'subscription_id and billing_day are required' });
  }
  if (billing_day < 1 || billing_day > 28) {
    return res.status(400).json({ error: 'billing_day must be between 1 and 28' });
  }

  try {
    const sub = await stripe.subscriptions.retrieve(subscription_id, { expand: ['customer', 'items.data.price'] });
    const customer = sub.customer;
    if (!customer || customer.deleted) return res.status(400).json({ error: 'The Stripe customer on this subscription no longer exists' });
    if (!customer.email) return res.status(400).json({ error: 'This Stripe customer has no email on file — cannot match or create a family' });

    const item = sub.items.data[0];
    const price = item?.price;
    if (!price) return res.status(400).json({ error: 'Could not read a price from this subscription' });
    const amount = Number(price.unit_amount) / 100;

    // Step 1: find or create the family
    let family;
    const existing = await pool.query(`SELECT * FROM families WHERE primary_parent_email = $1`, [customer.email]);
    if (existing.rows.length > 0) {
      family = existing.rows[0];
    } else {
      const created = await pool.query(
        `INSERT INTO families (primary_parent_name, primary_parent_email, primary_parent_phone)
         VALUES ($1,$2,$3) RETURNING *`,
        [customer.name || customer.email, customer.email, customer.phone || null]
      );
      family = created.rows[0];
    }

    // Step 2: attach the Stripe customer + card display info, so this app's
    // own billing can charge the SAME card the subscription was using —
    // reusing the Stripe Customer ID directly rather than creating a new one,
    // since the saved payment method lives on the Customer, not the Subscription.
    let cardBrand = null, cardLast4 = null;
    try {
      const stripeCustomer = await stripe.customers.retrieve(customer.id);
      const defaultPmId = stripeCustomer.invoice_settings?.default_payment_method || sub.default_payment_method;
      if (defaultPmId) {
        const pm = await stripe.paymentMethods.retrieve(typeof defaultPmId === 'string' ? defaultPmId : defaultPmId.id);
        if (pm.card) { cardBrand = pm.card.brand; cardLast4 = pm.card.last4; }
        // Make sure this Customer's default payment method is actually set,
        // in case it was only set at the Subscription level before.
        await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
      }
    } catch (cardErr) {
      console.error('Could not read/attach card while importing subscription', subscription_id, cardErr.message);
      // Continue anyway — the plan can still be created; it just won't have
      // a card to charge until one is added from the Families tab.
    }

    await pool.query(
      `UPDATE families SET stripe_customer_id = $2, card_brand = COALESCE($3, card_brand), card_last4 = COALESCE($4, card_last4),
              card_saved_at = CASE WHEN $3 IS NOT NULL THEN now() ELSE card_saved_at END
       WHERE id = $1`,
      [family.id, customer.id, cardBrand, cardLast4]
    );

    // Step 3: create the recurring plan
    const lineItems = [{
      description: price.nickname || sub.description || 'Recurring tuition (imported from Stripe)',
      quantity: 1,
      unit_price: amount,
    }];
    const planResult = await pool.query(
      `INSERT INTO recurring_plans (family_id, line_items, billing_day, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [family.id, JSON.stringify(lineItems), billing_day, req.staff.staff_id]
    );

    // Step 4: cancel the Stripe subscription LAST, only now that the new
    // plan is confirmed created.
    await stripe.subscriptions.cancel(subscription_id);

    res.status(201).json({
      family,
      plan: planResult.rows[0],
      card_attached: !!cardBrand,
      subscription_cancelled: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to import subscription: ' + err.message });
  }
});


router.get('/runs', async (req, res) => {
  const days = Number(req.query.days) || 7;
  try {
    const result = await pool.query(
      `SELECT rpr.*, rp.family_id, f.primary_parent_name, i.invoice_number, i.grand_total
       FROM recurring_plan_runs rpr
       JOIN recurring_plans rp ON rpr.recurring_plan_id = rp.id
       JOIN families f ON rp.family_id = f.id
       LEFT JOIN invoices i ON rpr.invoice_id = i.id
       WHERE rpr.run_date >= (CURRENT_DATE - ($1 || ' days')::interval)
       ORDER BY rpr.created_at DESC`,
      [days]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch run history' });
  }
});

// POST /recurring-plans/:id/run-now — admin manually triggers one plan
// immediately (e.g. testing, or catching up a missed day), bypassing the
// billing_day check but still respecting the once-per-day guard.
router.post('/:id(\\d+)/run-now', async (req, res) => {
  const runDate = new Date().toISOString().slice(0, 10);
  try {
    const planResult = await pool.query(
      `SELECT rp.*, f.primary_parent_name, f.stripe_customer_id, f.card_brand
       FROM recurring_plans rp JOIN families f ON rp.family_id = f.id
       WHERE rp.id = $1`,
      [req.params.id]
    );
    if (planResult.rows.length === 0) return res.status(404).json({ error: 'Recurring plan not found' });

    const alreadyRan = await pool.query(
      `SELECT 1 FROM recurring_plan_runs WHERE recurring_plan_id = $1 AND run_date = $2`,
      [req.params.id, runDate]
    );
    if (alreadyRan.rows.length > 0) return res.status(400).json({ error: 'This plan already ran today' });

    const result = await runOnePlan(planResult.rows[0], runDate);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run plan: ' + err.message });
  }
});

// Shared logic between the daily trigger and the manual "run now" button —
// generates an invoice from the plan's template line items, attempts the
// charge, logs the outcome, and emails admin a same-day notice either way.
async function runOnePlan(plan, runDate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lineItems = plan.line_items; // already parsed JSON from the jsonb column
    const subtotal = lineItems.reduce((sum, li) => sum + Number(li.quantity || 1) * Number(li.unit_price), 0);
    const invoiceNumber = 'INV-' + Date.now();
    const dueDate = runDate; // due same day it's generated — a recurring charge, not a bill to pay later

    const invoiceResult = await client.query(
      `INSERT INTO invoices (invoice_number, family_id, due_date, subtotal, tax_total, grand_total)
       VALUES ($1,$2,$3,$4,0,$4) RETURNING *`,
      [invoiceNumber, plan.family_id, dueDate, subtotal]
    );
    const invoice = invoiceResult.rows[0];

    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      const lineTotal = Number(li.quantity || 1) * Number(li.unit_price);
      await client.query(
        `INSERT INTO invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoice.id, i + 1, li.description, li.quantity || 1, li.unit_price, lineTotal]
      );
    }

    await client.query('COMMIT');

    // Charging happens AFTER the invoice transaction commits — a failed
    // charge should still leave a real (unpaid) invoice behind, not roll
    // back the whole thing, since admin needs a record of the attempt.
    let runStatus, errorMessage = null;
    if (!plan.stripe_customer_id || !plan.card_brand) {
      runStatus = 'no_card';
      errorMessage = 'This family has no saved card on file.';
    } else {
      try {
        const customer = await stripe.customers.retrieve(plan.stripe_customer_id);
        const paymentMethodId = customer.invoice_settings?.default_payment_method;
        if (!paymentMethodId) throw Object.assign(new Error('No default payment method found.'), { type: 'NoDefaultPM' });

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(subtotal * 100),
          currency: 'usd',
          customer: plan.stripe_customer_id,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          description: `Recurring invoice ${invoiceNumber} — The Little Playhut`,
          metadata: { invoice_id: String(invoice.id), recurring_plan_id: String(plan.id) },
        });

        if (paymentIntent.status === 'succeeded') {
          await pool.query(
            `UPDATE invoices SET status = 'paid', payment_method = 'card', stripe_payment_intent_id = $2, paid_at = now(), updated_at = now()
             WHERE id = $1`,
            [invoice.id, paymentIntent.id]
          );
          runStatus = 'charged';
        } else {
          runStatus = 'failed';
          errorMessage = `Charge did not complete (status: ${paymentIntent.status}).`;
        }
      } catch (stripeErr) {
        runStatus = 'failed';
        errorMessage = stripeErr.message || 'Unknown card error.';
      }
    }

    const runResult = await pool.query(
      `INSERT INTO recurring_plan_runs (recurring_plan_id, invoice_id, run_date, status, error_message, admin_notified_at)
       VALUES ($1,$2,$3,$4,$5, now()) RETURNING *`,
      [plan.id, invoice.id, runDate, runStatus, errorMessage]
    );

    // Same-day admin notice — best-effort, never blocks the run itself if
    // email isn't configured (sendEmail already fails silently/returns false).
    const adminEmail = process.env.EMAIL_USER;
    if (adminEmail) {
      const subjectStatus = runStatus === 'charged' ? 'charged successfully' : runStatus === 'no_card' ? 'skipped — no card on file' : 'FAILED';
      await sendEmail({
        to: [adminEmail],
        subject: `Recurring billing: ${plan.primary_parent_name} — ${subjectStatus}`,
        html: `
          <p>Recurring plan for <strong>${plan.primary_parent_name}</strong> ran today.</p>
          <p>Invoice: ${invoiceNumber} — $${subtotal.toFixed(2)}</p>
          <p>Result: <strong>${runStatus}</strong>${errorMessage ? ' — ' + errorMessage : ''}</p>
        `,
      });
    }

    return { plan_id: plan.id, family: plan.primary_parent_name, invoice_id: invoice.id, status: runStatus, error: errorMessage };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Recurring plan run failed before invoice was created:', err);
    return { plan_id: plan.id, family: plan.primary_parent_name, status: 'failed', error: err.message };
  } finally {
    client.release();
  }
}

module.exports = router;
