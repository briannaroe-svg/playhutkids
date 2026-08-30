const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const crypto = require('crypto');
const { uploadPdfBuffer } = require('../utils/cloudinary');
const { generateSignedAgreementPdf } = require('../utils/generateAgreementPdf');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// NOTE: this file deliberately does NOT use a blanket router.use(requireAdmin).
// The /sign/:token routes (GET and POST) must stay public — a signing parent
// is not a logged-in staff member. Every other route has requireAdmin applied
// individually. See agreements.js for the same pattern.

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
    res.status(201).json(result.rows[0]);
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

// Shared completion logic: given a registration row + signer info, creates the
// real family/child records and the signed PDF, all in one transaction.
async function completeRegistration(registration, { signer_name, signature_data, sign_method }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const familyResult = await client.query(
      `INSERT INTO families
        (primary_parent_name, primary_parent_email, primary_parent_phone,
         secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [registration.primary_parent_name, registration.primary_parent_email, registration.primary_parent_phone,
       registration.secondary_parent_name, registration.secondary_parent_email, registration.secondary_parent_phone,
       registration.mailing_address]
    );
    const familyId = familyResult.rows[0].id;

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

module.exports = router;
