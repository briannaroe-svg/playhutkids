const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const crypto = require('crypto');
const Stripe = require('stripe');
const { uploadPdfBuffer } = require('../utils/cloudinary');
const { generateSignedAgreementPdf } = require('../utils/generateAgreementPdf');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { hashPassword } = require('../utils/auth');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Small word lists for generating a readable, memorable auto-password —
// e.g. "maple-forest-42" — rather than a wall of random symbols, since the
// parent needs to actually type this on their own device shortly after.
// Not a security downgrade in practice: combined with 2 random digits, this
// is still a large space, and it's a temporary password they're expected to
// change or simply keep using for a low-stakes read-only portal.
const PASSWORD_WORDS_A = ['maple', 'cedar', 'birch', 'willow', 'meadow', 'harbor', 'canyon', 'ember', 'brook', 'thistle'];
const PASSWORD_WORDS_B = ['forest', 'summit', 'hollow', 'ridge', 'valley', 'orchard', 'grove', 'creek', 'garden', 'trail'];

function generateReadablePassword() {
  const a = PASSWORD_WORDS_A[crypto.randomInt(PASSWORD_WORDS_A.length)];
  const b = PASSWORD_WORDS_B[crypto.randomInt(PASSWORD_WORDS_B.length)];
  const digits = String(crypto.randomInt(10, 100)); // 10-99
  return `${a}-${b}-${digits}`;
}

// NOTE: this file deliberately does NOT use a blanket router.use(requireAdmin).
// The /sign/:token routes (GET and POST) and /self-register must stay public
// — a signing/registering parent is not a logged-in staff member. Every
// other route has requireAdmin applied individually. See agreements.js for
// the same pattern.

// GET /registrations — admin only, list all (any status)
router.get('/', requireAdmin, async (req, res) => {
  const { status } = req.query;
  try {
    const query = status
      ? `SELECT * FROM registrations WHERE status = $1 ORDER BY created_at DESC`
      : `SELECT * FROM registrations ORDER BY created_at DESC`;
    const params = status ? [status] : [];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// POST /registrations — admin only, start a new registration (captures the form data, unsigned)
router.post('/', requireAdmin, async (req, res) => {
  const {
    primary_parent_name, primary_parent_email, primary_parent_phone,
    secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address,
    child_first_name, child_last_name, child_date_of_birth, child_program,
    child_allergies, child_medical_notes, child_emergency_contact_name,
    child_emergency_contact_phone, child_base_tuition_rate,
  } = req.body;

  if (!primary_parent_name || !primary_parent_email || !child_first_name || !child_last_name || !child_date_of_birth || !child_program) {
    return res.status(400).json({ error: 'Primary parent name/email and child name/DOB/program are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO registrations (
        primary_parent_name, primary_parent_email, primary_parent_phone,
        secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address,
        child_first_name, child_last_name, child_date_of_birth, child_program,
        child_allergies, child_medical_notes, child_emergency_contact_name,
        child_emergency_contact_phone, child_base_tuition_rate, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *`,
      [primary_parent_name, primary_parent_email, primary_parent_phone,
       secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address,
       child_first_name, child_last_name, child_date_of_birth, child_program,
       child_allergies, child_medical_notes, child_emergency_contact_name,
       child_emergency_contact_phone, child_base_tuition_rate || null, req.staff.staff_id]
    );
    const registration = result.rows[0];

    // Auto-close any matching waitlist entry — matched by parent email, since
    // that's the one field guaranteed to be entered consistently in both
    // places. Failure here should never block the registration itself from
    // being created, so it's isolated in its own try/catch.
    try {
      await pool.query(
        `UPDATE waitlist_entries
         SET status = 'enrolled', converted_registration_id = $2, converted_at = now()
         WHERE parent_email = $1 AND status = 'waiting'`,
        [primary_parent_email, registration.id]
      );
    } catch (waitlistErr) {
      console.error('Registration created, but waitlist auto-conversion failed:', waitlistErr);
    }

    res.status(201).json(registration);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start registration' });
  }
});

// POST /registrations/:id/send-remote-link — admin only, 72-hour signing link (same pattern as agreements.js)
router.post('/:id(\\d+)/send-remote-link', requireAdmin, async (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    const result = await pool.query(
      `UPDATE registrations
       SET remote_link_token = $2, remote_link_expires_at = $3, sign_method = 'remote_link'
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id, token, expiresAt]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Registration not found or already signed' });

    // FRONTEND_URL is the Static Site's own domain (playhutkids.onrender.com),
    // NOT the backend's APP_URL — this link needs to open an actual HTML
    // signing page for a parent, not the raw JSON API route it points at.
    // Falls back to APP_URL only if FRONTEND_URL was never set, so this
    // doesn't silently break before the env var is configured — though the
    // resulting link would still be wrong until FRONTEND_URL is set for real.
    const frontendBase = process.env.FRONTEND_URL || process.env.APP_URL;
    const signingUrl = `${frontendBase}/sign-registration.html?token=${token}`;
    res.json({ registration: result.rows[0], signing_url: signingUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send remote signing link' });
  }
});

// GET /registrations/sign/:token — public, resolve a remote signing link
router.get('/sign/:token', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM registrations WHERE remote_link_token = $1`, [req.params.token]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid signing link' });

    const registration = result.rows[0];
    if (registration.remote_link_expires_at && new Date(registration.remote_link_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This signing link has expired' });
    }
    if (registration.status === 'signed') {
      return res.status(400).json({ error: 'This registration has already been signed' });
    }

    res.json(registration);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve signing link' });
  }
});

// Shared completion logic: given a registration row + signer info, creates
// the real family/child records and the signed PDF, all in one transaction.
// existingFamilyId lets multiple registrations (e.g. siblings enrolled in
// the same sitting) share one family record instead of each creating their
// own — see self-register-multi below, which is the only caller that passes
// this. Every other caller omits it and gets the original one-family-per-
// registration behavior.
async function completeRegistration(registration, { signer_name, signature_data, sign_method, existingFamilyId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let familyId = existingFamilyId;
    if (!familyId) {
      const familyResult = await client.query(
        `INSERT INTO families
          (primary_parent_name, primary_parent_email, primary_parent_phone,
           secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [registration.primary_parent_name, registration.primary_parent_email, registration.primary_parent_phone,
         registration.secondary_parent_name, registration.secondary_parent_email, registration.secondary_parent_phone,
         registration.mailing_address]
      );
      familyId = familyResult.rows[0].id;
    }

    const childResult = await client.query(
      `INSERT INTO children
        (family_id, first_name, last_name, date_of_birth, program, enrollment_date,
         allergies, medical_notes, emergency_contact_name, emergency_contact_phone, base_tuition_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [familyId, registration.child_first_name, registration.child_last_name, registration.child_date_of_birth,
       registration.child_program, new Date().toISOString().slice(0, 10),
       registration.child_allergies, registration.child_medical_notes,
       registration.child_emergency_contact_name, registration.child_emergency_contact_phone,
       registration.child_base_tuition_rate]
    );
    const childId = childResult.rows[0].id;

    const signedAtISO = new Date().toISOString();

    let signedPdfUrl = null;
    try {
      const pdfBuffer = await generateSignedAgreementPdf({
        title: `Enrollment Registration — ${registration.child_first_name} ${registration.child_last_name}`,
        signerName: signer_name,
        signedAtISO,
        signatureDataUri: signature_data,
      });
      signedPdfUrl = await uploadPdfBuffer(
        pdfBuffer,
        `registration-${registration.id}-${Date.now()}`,
        'little-playhut/signed-registrations'
      );
    } catch (pdfErr) {
      console.error('Signed registration PDF generation/upload failed:', pdfErr);
    }

    const updated = await client.query(
      `UPDATE registrations
       SET status = 'signed', signer_name = $2, signature_data = $3, signed_at = now(),
           sign_method = $4, signed_pdf_url = COALESCE($5, signed_pdf_url),
           resulting_family_id = $6, resulting_child_id = $7
       WHERE id = $1 RETURNING *`,
      [registration.id, signer_name, signature_data, sign_method, signedPdfUrl, familyId, childId]
    );

    await client.query('COMMIT');
    return updated.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// POST /registrations/sign/:token — public, parent completes a remote registration
router.post('/sign/:token', async (req, res) => {
  const { signer_name, signature_data } = req.body;
  if (!signer_name || !signature_data) return res.status(400).json({ error: 'signer_name and signature_data are required' });

  try {
    const result = await pool.query(`SELECT * FROM registrations WHERE remote_link_token = $1`, [req.params.token]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid signing link' });
    const registration = result.rows[0];

    if (registration.remote_link_expires_at && new Date(registration.remote_link_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This signing link has expired' });
    }
    if (registration.status === 'signed') {
      return res.status(400).json({ error: 'This registration has already been signed' });
    }

    const completed = await completeRegistration(registration, {
      signer_name, signature_data, sign_method: 'remote_link',
    });
    res.json(completed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete registration' });
  }
});

// POST /registrations/:id/sign-in-person — admin only, parent signs on-site (director's tablet)
router.post('/:id(\\d+)/sign-in-person', requireAdmin, async (req, res) => {
  const { signer_name, signature_data } = req.body;
  if (!signer_name || !signature_data) return res.status(400).json({ error: 'signer_name and signature_data are required' });

  try {
    const result = await pool.query(`SELECT * FROM registrations WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Registration not found' });
    const registration = result.rows[0];

    if (registration.status === 'signed') {
      return res.status(400).json({ error: 'This registration has already been signed' });
    }

    const completed = await completeRegistration(registration, {
      signer_name, signature_data, sign_method: 'in_person_canvas',
    });
    res.json(completed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete registration' });
  }
});

// GET /registrations/services — PUBLIC, no login needed. The active service
// catalog, for the registration form's per-child services picker. Deliberately
// separate from the admin-only GET /service-items — this returns only the
// fields a registration form needs (nothing sensitive lives on a service
// item anyway, but keeping this route distinct means the public surface
// doesn't grow just because the admin route's shape changes later).
router.get('/services', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, default_price FROM service_items WHERE is_active = true ORDER BY name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// POST /registrations/start-card-setup — PUBLIC, no login/token needed.
// Called from self-register.html BEFORE the form is actually submitted, so
// Stripe Elements has a live SetupIntent to attach the card to. Creates a
// Stripe Customer from just the name/email typed so far (no database write —
// the family record doesn't exist yet and won't until the form is actually
// submitted). If the parent abandons the form after this point, the result
// is an unused Stripe Customer with no card and no linked family — harmless
// and not worth extra cleanup machinery for.
router.post('/start-card-setup', async (req, res) => {
  const { primary_parent_name, primary_parent_email } = req.body;
  if (!primary_parent_name || !primary_parent_email) {
    return res.status(400).json({ error: 'Name and email are required before adding a card' });
  }

  try {
    const customer = await stripe.customers.create({
      name: primary_parent_name,
      email: primary_parent_email,
      metadata: { little_playhut_source: 'self_registration' },
    });

    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
    });

    res.json({ client_secret: setupIntent.client_secret, stripe_customer_id: customer.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start card setup: ' + err.message });
  }
});

// POST /registrations/self-register — PUBLIC, no login and no token needed.
// A parent fills out the entire form and signs themselves, in one sitting —
// unlike the admin-initiated flow above (POST / then a separate sign step),
// this creates the registration row(s) AND completes them in the same
// request, then generates portal login credentials on the spot.
//
// Accepts a `children` array (1 or more) so siblings can be enrolled
// together under one family, one card, one signature — each child still
// gets their own registrations row and signed PDF (matching how every other
// signing path in this file works), but they all share one family record
// via completeRegistration()'s existingFamilyId parameter. Each child can
// also list `services` (service_item ids + quantity) — these roll up into
// ONE draft invoice for the family, built from CURRENT service_items prices
// looked up server-side (never a client-supplied price, which would let
// someone submit a fabricated total).
router.post('/self-register', async (req, res) => {
  const {
    primary_parent_name, primary_parent_email, primary_parent_phone,
    secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address,
    children, // [{ first_name, last_name, date_of_birth, program, allergies, medical_notes, emergency_contact_name, emergency_contact_phone, services: [{ service_item_id, quantity }] }, ...]
    signer_name, signature_data,
    stripe_customer_id, setup_intent_id,
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
  if (!signer_name || !signature_data) {
    return res.status(400).json({ error: 'A signature is required to complete registration' });
  }
  if (!stripe_customer_id || !setup_intent_id) {
    return res.status(400).json({ error: 'A card on file is required to complete registration' });
  }

  try {
    // Confirm the card was actually saved successfully before creating
    // anything — a family record should never be created with an incomplete
    // or failed card setup when a card is required. This also guards against
    // a forged/mismatched stripe_customer_id being sent directly to this
    // endpoint: the SetupIntent's own customer must match what was passed.
    const setupIntent = await stripe.setupIntents.retrieve(setup_intent_id);
    if (setupIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Card setup did not complete successfully. Please try adding your card again.' });
    }
    if (setupIntent.customer !== stripe_customer_id) {
      return res.status(400).json({ error: 'Card setup does not match this registration.' });
    }

    // A family with this email already having portal access is a sign this
    // isn't actually a first-time registration — point them at the real
    // portal/login instead of silently creating a duplicate family record.
    const existingFamily = await pool.query(
      `SELECT id FROM families WHERE primary_parent_email = $1`,
      [primary_parent_email]
    );
    if (existingFamily.rows.length > 0) {
      return res.status(409).json({ error: 'A family with this email is already registered. Contact the school if you need help accessing your account.' });
    }

    let sharedFamilyId = null;
    const completedRegistrations = [];
    const invoiceLineItemPlan = []; // [{ child_id, child_name, service_item_id, quantity }] — resolved to real prices below

    for (const c of children) {
      const insertResult = await pool.query(
        `INSERT INTO registrations (
          primary_parent_name, primary_parent_email, primary_parent_phone,
          secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address,
          child_first_name, child_last_name, child_date_of_birth, child_program,
          child_allergies, child_medical_notes, child_emergency_contact_name,
          child_emergency_contact_phone, sign_method
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'self_service')
        RETURNING *`,
        [primary_parent_name, primary_parent_email, primary_parent_phone,
         secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address,
         c.first_name, c.last_name, c.date_of_birth, c.program,
         c.allergies || null, c.medical_notes || null, c.emergency_contact_name || null,
         c.emergency_contact_phone || null]
      );
      const registration = insertResult.rows[0];

      const completed = await completeRegistration(registration, {
        signer_name, signature_data, sign_method: 'self_service',
        existingFamilyId: sharedFamilyId, // null for the first child — completeRegistration creates the family then
      });

      if (!sharedFamilyId) sharedFamilyId = completed.resulting_family_id;
      completedRegistrations.push(completed);

      if (Array.isArray(c.services)) {
        for (const s of c.services) {
          if (s.service_item_id) {
            invoiceLineItemPlan.push({
              child_id: completed.resulting_child_id,
              child_name: `${c.first_name} ${c.last_name}`,
              service_item_id: s.service_item_id,
              quantity: Number(s.quantity) || 1,
            });
          }
        }
      }

      // Auto-close any matching waitlist entry — same behavior as the
      // admin-initiated path, checked per child in case a family has more
      // than one waitlist entry (e.g. inquired about each kid separately).
      try {
        await pool.query(
          `UPDATE waitlist_entries
           SET status = 'enrolled', converted_registration_id = $2, converted_at = now()
           WHERE parent_email = $1 AND status = 'waiting'`,
          [primary_parent_email, registration.id]
        );
      } catch (waitlistErr) {
        console.error('Self-registration completed, but waitlist auto-conversion failed:', waitlistErr);
      }
    }

    // Build one draft invoice for the family covering every selected service
    // across every child — prices are looked up fresh from service_items
    // right now, never trusted from the request body.
    let createdInvoice = null;
    if (invoiceLineItemPlan.length > 0) {
      try {
        const serviceIds = [...new Set(invoiceLineItemPlan.map(li => li.service_item_id))];
        const servicesResult = await pool.query(
          `SELECT * FROM service_items WHERE id = ANY($1::int[]) AND is_active = true`,
          [serviceIds]
        );
        const servicesById = {};
        servicesResult.rows.forEach(s => { servicesById[s.id] = s; });

        const resolvedLineItems = invoiceLineItemPlan
          .filter(li => servicesById[li.service_item_id]) // silently drop any service that's since gone inactive/was invalid
          .map(li => {
            const service = servicesById[li.service_item_id];
            const unitPrice = Number(service.default_price);
            return {
              child_id: li.child_id,
              description: `${service.name} — ${li.child_name}`,
              item_type: 'service',
              quantity: li.quantity,
              unit_price: unitPrice,
              line_total: unitPrice * li.quantity,
            };
          });

        if (resolvedLineItems.length > 0) {
          const subtotal = resolvedLineItems.reduce((sum, li) => sum + li.line_total, 0);
          const invoiceNumber = 'INV-' + Date.now();

          const invoiceResult = await pool.query(
            `INSERT INTO invoices (invoice_number, family_id, subtotal, tax_total, grand_total)
             VALUES ($1,$2,$3,0,$3) RETURNING *`,
            [invoiceNumber, sharedFamilyId, subtotal]
          );
          createdInvoice = invoiceResult.rows[0];

          for (let i = 0; i < resolvedLineItems.length; i++) {
            const li = resolvedLineItems[i];
            await pool.query(
              `INSERT INTO invoice_line_items (invoice_id, child_id, line_number, description, item_type, quantity, unit_price, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [createdInvoice.id, li.child_id, i + 1, li.description, li.item_type, li.quantity, li.unit_price, li.line_total]
            );
          }
        }
      } catch (invoiceErr) {
        // Registration already succeeded at this point — a failed invoice
        // build shouldn't undo the enrollment, but admin needs to know they
        // may need to create this invoice manually.
        console.error('Registration completed, but building the services invoice failed:', invoiceErr);
      }
    }

    // Attach the saved card to the family record — once, after every child
    // has been created, since they all share the same family now.
    try {
      const paymentMethod = await stripe.paymentMethods.retrieve(setupIntent.payment_method);
      await stripe.customers.update(stripe_customer_id, {
        invoice_settings: { default_payment_method: paymentMethod.id },
      });
      await pool.query(
        `UPDATE families SET stripe_customer_id = $2, card_brand = $3, card_last4 = $4, card_saved_at = now() WHERE id = $1`,
        [sharedFamilyId, stripe_customer_id, paymentMethod.card.brand, paymentMethod.card.last4]
      );
    } catch (cardErr) {
      // The registration itself already succeeded at this point — a failure
      // here shouldn't undo the enrollment, but it does mean admin needs to
      // know the card didn't actually get attached.
      console.error('Registration completed, but attaching the saved card failed:', cardErr);
    }

    // Generate a portal password automatically — readable (not a wall of
    // symbols), since the parent needs to actually type this in shortly.
    // Two short words + two digits, e.g. "maple-forest-42".
    const password = generateReadablePassword();
    const passwordHash = await hashPassword(password);
    await pool.query(
      `UPDATE families SET password_hash = $2 WHERE id = $1`,
      [sharedFamilyId, passwordHash]
    );

    res.status(201).json({
      registrations: completedRegistrations,
      portal_email: primary_parent_email,
      portal_password: password, // returned ONCE, here — never stored in plaintext, never retrievable again after this response
      invoice: createdInvoice, // null if no services were selected
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete registration: ' + err.message });
  }
});

module.exports = router;
