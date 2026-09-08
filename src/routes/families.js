const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const Stripe = require('stripe');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Column list shared by every read route below — explicitly excludes
// password_hash (the parent portal login secret) and instead exposes a
// derived boolean, has_portal_access, so the admin UI can show portal status
// without ever receiving the hash itself. card_brand/card_last4 are safe,
// non-sensitive display info only — never the actual card number.
const FAMILY_COLUMNS = `
  id, primary_parent_name, primary_parent_email, primary_parent_phone,
  secondary_parent_name, secondary_parent_email, secondary_parent_phone,
  mailing_address, stripe_customer_id, card_brand, card_last4, card_saved_at,
  created_at, updated_at, is_unenrolled,
  (password_hash IS NOT NULL) AS has_portal_access,
  NOT is_unenrolled AS has_active_child
`;

// A family is hidden from the default view whenever is_unenrolled is true —
// a direct flag on the family itself, not derived from its children's
// statuses. This matters for a family with ZERO children (e.g. created but
// no child added yet, or a test record): under a purely children-derived
// rule, such a family could never be marked unenrolled at all, since there's
// no child to withdraw. Unenrolling still withdraws any active children and
// pauses recurring plans as a side effect — see /unenroll below — but
// whether the family itself counts as unenrolled no longer depends on that.
// The checkbox is a strict toggle, not additive: unchecked shows ONLY
// enrolled families, checked shows ONLY unenrolled ones — never both mixed
// together, since that reads as "nothing changed" when checked.
router.get('/search', async (req, res) => {
  const { q, include_unenrolled } = req.query;
  const wantUnenrolled = include_unenrolled === 'true';
  try {
    const result = await pool.query(
      `SELECT ${FAMILY_COLUMNS} FROM families
       WHERE (primary_parent_name ILIKE $1 OR primary_parent_email ILIKE $1)
         AND is_unenrolled = $2`,
      [`%${q || ''}%`, wantUnenrolled]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search families' });
  }
});

router.get('/', async (req, res) => {
  const { include_unenrolled } = req.query;
  const wantUnenrolled = include_unenrolled === 'true';
  try {
    const result = await pool.query(
      `SELECT ${FAMILY_COLUMNS} FROM families
       WHERE is_unenrolled = $1
       ORDER BY primary_parent_name`,
      [wantUnenrolled]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch families' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const family = await pool.query(`SELECT ${FAMILY_COLUMNS} FROM families WHERE id = $1`, [req.params.id]);
    if (family.rows.length === 0) return res.status(404).json({ error: 'Family not found' });
    const children = await pool.query(`SELECT * FROM children WHERE family_id = $1`, [req.params.id]);
    res.json({ ...family.rows[0], children: children.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch family' });
  }
});

router.post('/', async (req, res) => {
  const {
    primary_parent_name, primary_parent_email, primary_parent_phone,
    secondary_parent_name, secondary_parent_email, secondary_parent_phone,
    mailing_address,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO families
        (primary_parent_name, primary_parent_email, primary_parent_phone,
         secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [primary_parent_name, primary_parent_email, primary_parent_phone,
       secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create family' });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  const fields = req.body;
  const setClauses = Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = Object.values(fields);

  try {
    const result = await pool.query(
      `UPDATE families SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Family not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update family' });
  }
});

// ============================================================
// SAVED CARD (Stripe SetupIntent flow)
// The card number itself NEVER reaches this server — the frontend uses
// Stripe Elements/Stripe.js to send it directly to Stripe from the browser.
// This server only ever sees a client_secret (to let the browser complete
// the setup) and, afterward, a payment_method_id reference — never digits.
// ============================================================

// POST /families/:id/setup-intent — start saving a card for this family.
// Creates a Stripe Customer for the family if one doesn't exist yet, then a
// SetupIntent tied to that Customer. Returns the client_secret the frontend
// needs to complete Stripe Elements' card collection.
router.post('/:id(\\d+)/setup-intent', async (req, res) => {
  try {
    const familyResult = await pool.query(`SELECT * FROM families WHERE id = $1`, [req.params.id]);
    if (familyResult.rows.length === 0) return res.status(404).json({ error: 'Family not found' });
    const family = familyResult.rows[0];

    let customerId = family.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: family.primary_parent_name,
        email: family.primary_parent_email,
        metadata: { little_playhut_family_id: String(family.id) },
      });
      customerId = customer.id;
      await pool.query(`UPDATE families SET stripe_customer_id = $2 WHERE id = $1`, [req.params.id, customerId]);
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    });

    res.json({ client_secret: setupIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start card setup: ' + err.message });
  }
});

// POST /families/:id/confirm-card — called by the frontend once Stripe
// Elements has confirmed the SetupIntent client-side. Looks up the resulting
// payment method on Stripe, sets it as the Customer's default, and caches
// only the safe brand/last4 for display — never the card number itself,
// which this server never receives at any point in this flow.
router.post('/:id(\\d+)/confirm-card', async (req, res) => {
  const { setup_intent_id } = req.body;
  if (!setup_intent_id) return res.status(400).json({ error: 'setup_intent_id is required' });

  try {
    const familyResult = await pool.query(`SELECT * FROM families WHERE id = $1`, [req.params.id]);
    if (familyResult.rows.length === 0) return res.status(404).json({ error: 'Family not found' });
    const family = familyResult.rows[0];

    const setupIntent = await stripe.setupIntents.retrieve(setup_intent_id);
    if (setupIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Card setup did not complete successfully' });
    }
    if (setupIntent.customer !== family.stripe_customer_id) {
      return res.status(400).json({ error: 'This card setup does not belong to this family' });
    }

    const paymentMethod = await stripe.paymentMethods.retrieve(setupIntent.payment_method);

    await stripe.customers.update(family.stripe_customer_id, {
      invoice_settings: { default_payment_method: paymentMethod.id },
    });

    const result = await pool.query(
      `UPDATE families SET card_brand = $2, card_last4 = $3, card_saved_at = now()
       WHERE id = $1 RETURNING ${FAMILY_COLUMNS}`,
      [req.params.id, paymentMethod.card.brand, paymentMethod.card.last4]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm card: ' + err.message });
  }
});

// DELETE /families/:id/payment-method — remove the saved card
router.delete('/:id(\\d+)/payment-method', async (req, res) => {
  try {
    const familyResult = await pool.query(`SELECT * FROM families WHERE id = $1`, [req.params.id]);
    if (familyResult.rows.length === 0) return res.status(404).json({ error: 'Family not found' });
    const family = familyResult.rows[0];

    if (family.stripe_customer_id) {
      const customer = await stripe.customers.retrieve(family.stripe_customer_id);
      const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method;
      if (defaultPaymentMethodId) {
        await stripe.paymentMethods.detach(defaultPaymentMethodId);
      }
    }

    await pool.query(
      `UPDATE families SET card_brand = NULL, card_last4 = NULL, card_saved_at = NULL WHERE id = $1`,
      [req.params.id]
    );

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove card: ' + err.message });
  }
});

// POST /families/bulk-import-enrollment — a one-time-use style route for
// bringing already-enrolled families (e.g. from a Google Form or another
// system) directly into Families/Children, WITHOUT going through the normal
// self-registration flow — no signature, no card, no services required,
// since these families already went through their own onboarding elsewhere.
// Accepts one family + its children per call; the frontend review screen
// calls this once per approved row after the admin has checked/corrected it.
router.post('/bulk-import-enrollment', async (req, res) => {
  const {
    primary_parent_name, primary_parent_email, primary_parent_phone,
    secondary_parent_name, secondary_parent_email, secondary_parent_phone,
    mailing_address,
    children, // [{ first_name, last_name, date_of_birth, program, allergies, emergency_contact_name, emergency_contact_phone }]
  } = req.body;

  if (!primary_parent_name || !primary_parent_email) {
    return res.status(400).json({ error: 'Primary parent name and email are required' });
  }
  if (!Array.isArray(children) || children.length === 0) {
    return res.status(400).json({ error: 'At least one child is required' });
  }
  for (const c of children) {
    if (!c.first_name || !c.last_name || !c.date_of_birth || !c.program) {
      return res.status(400).json({ error: 'Each child needs a first name, last name, date of birth, and program' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reuse an existing family if this exact email is already in the system
    // (e.g. importing a second program's row for a family already created
    // from the first) rather than creating a duplicate.
    let family;
    const existing = await client.query(`SELECT * FROM families WHERE primary_parent_email = $1`, [primary_parent_email]);
    if (existing.rows.length > 0) {
      family = existing.rows[0];
    } else {
      const created = await client.query(
        `INSERT INTO families (primary_parent_name, primary_parent_email, primary_parent_phone,
                                secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [primary_parent_name, primary_parent_email, primary_parent_phone || null,
         secondary_parent_name || null, secondary_parent_email || null, secondary_parent_phone || null,
         mailing_address || null]
      );
      family = created.rows[0];
    }

    const createdChildren = [];
    for (const c of children) {
      const childResult = await client.query(
        `INSERT INTO children (family_id, first_name, last_name, date_of_birth, program, allergies,
                                emergency_contact_name, emergency_contact_phone, enrollment_status, enrollment_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active', CURRENT_DATE) RETURNING *`,
        [family.id, c.first_name, c.last_name, c.date_of_birth, c.program, c.allergies || null,
         c.emergency_contact_name || null, c.emergency_contact_phone || null]
      );
      createdChildren.push(childResult.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ family, children: createdChildren });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to import family: ' + err.message });
  } finally {
    client.release();
  }
});

// POST /families/:id/unenroll — withdraws EVERY active child under this
// family and pauses every active recurring plan for it. Used for the
// family-level "unenroll" action (as opposed to withdrawing one child at a
// time from Children), when the whole household is leaving at once.
router.post('/:id(\\d+)/unenroll', async (req, res) => {
  try {
    const familyResult = await pool.query(`SELECT * FROM families WHERE id = $1`, [req.params.id]);
    if (familyResult.rows.length === 0) return res.status(404).json({ error: 'Family not found' });

    await pool.query(
      `UPDATE families SET is_unenrolled = true, unenrolled_at = now(), updated_at = now() WHERE id = $1`,
      [req.params.id]
    );

    const withdrawnChildren = await pool.query(
      `UPDATE children SET enrollment_status = 'withdrawn', withdrawal_date = CURRENT_DATE, updated_at = now()
       WHERE family_id = $1 AND enrollment_status = 'active' RETURNING id`,
      [req.params.id]
    );

    const pausedPlans = await pool.query(
      `UPDATE recurring_plans SET is_active = false, updated_at = now()
       WHERE family_id = $1 AND is_active = true RETURNING id`,
      [req.params.id]
    );

    res.json({
      children_withdrawn: withdrawnChildren.rows.length,
      recurring_plans_paused: pausedPlans.rows.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to unenroll family: ' + err.message });
  }
});

module.exports = router;
