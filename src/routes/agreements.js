const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const crypto = require('crypto');
const { uploadPdfBuffer } = require('../utils/cloudinary');
const { generateSignedAgreementPdf } = require('../utils/generateAgreementPdf');
const { requireAdmin } = require('../middleware/auth');

// NOTE: this file deliberately does NOT use a blanket router.use(requireAdmin).
// The /sign/:token routes (GET and POST) must stay public — that's the whole
// point of the token-based remote signing flow; a signing parent is not a
// logged-in staff member. Every other route below has requireAdmin applied
// individually. Do not add a blanket router.use(requireAdmin) here without
// re-excluding the /sign/:token routes, or remote signing will break.

// GET /agreements/templates — active handbook versions
router.get('/templates', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM agreement_templates WHERE is_active = true ORDER BY agreement_type`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agreement templates' });
  }
});

// POST /agreements/templates — register a new handbook version.
// Upload the source PDF to Cloudinary yourself (or via a future admin upload UI)
// and pass the resulting URL here as content_url, or omit it if the handbook
// content lives only in the signed-agreement PDF text itself.
router.post('/templates', requireAdmin, async (req, res) => {
  const { agreement_type, version, title, content_url } = req.body;
  try {
    // Deactivate any prior version of the same agreement_type so only one is "active"
    await pool.query(
      `UPDATE agreement_templates SET is_active = false WHERE agreement_type = $1`,
      [agreement_type]
    );
    const result = await pool.query(
      `INSERT INTO agreement_templates (agreement_type, version, title, content_url, is_active)
       VALUES ($1,$2,$3,$4,true) RETURNING *`,
      [agreement_type, version, title, content_url || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create agreement template' });
  }
});

// GET /agreements?family_id=&status=
router.get('/', requireAdmin, async (req, res) => {
  const { family_id, status } = req.query;
  try {
    let query = `SELECT * FROM agreements WHERE 1=1`;
    const params = [];
    if (family_id) { params.push(family_id); query += ` AND family_id = $${params.length}`; }
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    query += ` ORDER BY created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agreements' });
  }
});

// POST /agreements — create a pending agreement (daycare or preschool handbook) for a family
router.post('/', requireAdmin, async (req, res) => {
  const { template_id, family_id, child_id } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO agreements (template_id, family_id, child_id, status)
       VALUES ($1,$2,$3,'pending') RETURNING *`,
      [template_id, family_id, child_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create agreement' });
  }
});

// POST /agreements/:id/send-remote-link — generate 72-hour signing link (KP pattern)
router.post('/:id(\\d+)/send-remote-link', requireAdmin, async (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours

    const result = await pool.query(
      `UPDATE agreements
       SET remote_link_token = $2, remote_link_expires_at = $3, status = 'sent',
           sent_at = now(), sign_method = 'remote_link'
       WHERE id = $1 RETURNING *`,
      [req.params.id, token, expiresAt]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Agreement not found' });

    // APP_URL must be set to the correct Render URL for this link to resolve
    const signingUrl = `${process.env.APP_URL}/agreements/sign/${token}`;

    // TODO: wire up email send here (same pattern as KP's remote signing emails)
    res.json({ agreement: result.rows[0], signing_url: signingUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send remote signing link' });
  }
});

// GET /agreements/sign/:token — resolve a remote signing link (public, no auth — token is the auth)
router.get('/sign/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, t.title, t.content_url, t.agreement_type
       FROM agreements a JOIN agreement_templates t ON a.template_id = t.id
       WHERE a.remote_link_token = $1`,
      [req.params.token]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid signing link' });

    const agreement = result.rows[0];
    if (agreement.remote_link_expires_at && new Date(agreement.remote_link_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This signing link has expired' });
    }
    if (agreement.status === 'signed') {
      return res.status(400).json({ error: 'This agreement has already been signed' });
    }

    res.json(agreement);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve signing link' });
  }
});

// POST /agreements/sign/:token — submit signature (canvas base64 image, in-person or remote)
router.post('/sign/:token', async (req, res) => {
  const { signer_name, signature_data } = req.body;
  try {
    const agreementResult = await pool.query(
      `SELECT a.*, t.title
       FROM agreements a JOIN agreement_templates t ON a.template_id = t.id
       WHERE a.remote_link_token = $1`,
      [req.params.token]
    );
    if (agreementResult.rows.length === 0) return res.status(404).json({ error: 'Invalid signing link' });
    const agreement = agreementResult.rows[0];

    if (agreement.remote_link_expires_at && new Date(agreement.remote_link_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This signing link has expired' });
    }

    await pool.query(
      `INSERT INTO agreement_signatures (agreement_id, signer_name, signature_data, signed_ip)
       VALUES ($1,$2,$3,$4)`,
      [agreement.id, signer_name, signature_data, req.ip]
    );

    const signedAtISO = new Date().toISOString();

    // Generate the signed PDF and upload it to Cloudinary. If this step fails,
    // the signature itself is already recorded in agreement_signatures above —
    // we still mark the agreement signed, just without a PDF copy, rather than
    // losing the signature over a PDF/upload failure.
    let signedPdfUrl = null;
    try {
      const pdfBuffer = await generateSignedAgreementPdf({
        title: agreement.title,
        signerName: signer_name,
        signedAtISO,
        signatureDataUri: signature_data,
      });
      signedPdfUrl = await uploadPdfBuffer(
        pdfBuffer,
        `agreement-${agreement.id}-${Date.now()}`,
        'little-playhut/signed-agreements'
      );
    } catch (pdfErr) {
      console.error('Signed PDF generation/upload failed:', pdfErr);
    }

    const updated = await pool.query(
      `UPDATE agreements SET status = 'signed', signed_at = now(), signed_pdf_url = COALESCE($2, signed_pdf_url)
       WHERE id = $1 RETURNING *`,
      [agreement.id, signedPdfUrl]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit signature' });
  }
});

// POST /agreements/:id/sign-in-person — canvas signature captured on-site (director's tablet/laptop)
router.post('/:id(\\d+)/sign-in-person', requireAdmin, async (req, res) => {
  const { signer_name, signature_data } = req.body;
  try {
    const agreementResult = await pool.query(
      `SELECT a.*, t.title
       FROM agreements a JOIN agreement_templates t ON a.template_id = t.id
       WHERE a.id = $1`,
      [req.params.id]
    );
    if (agreementResult.rows.length === 0) return res.status(404).json({ error: 'Agreement not found' });
    const agreement = agreementResult.rows[0];

    await pool.query(
      `INSERT INTO agreement_signatures (agreement_id, signer_name, signature_data, signed_ip)
       VALUES ($1,$2,$3,$4)`,
      [req.params.id, signer_name, signature_data, req.ip]
    );

    const signedAtISO = new Date().toISOString();

    let signedPdfUrl = null;
    try {
      const pdfBuffer = await generateSignedAgreementPdf({
        title: agreement.title,
        signerName: signer_name,
        signedAtISO,
        signatureDataUri: signature_data,
      });
      signedPdfUrl = await uploadPdfBuffer(
        pdfBuffer,
        `agreement-${agreement.id}-${Date.now()}`,
        'little-playhut/signed-agreements'
      );
    } catch (pdfErr) {
      console.error('Signed PDF generation/upload failed:', pdfErr);
    }

    const updated = await pool.query(
      `UPDATE agreements
       SET status = 'signed', signed_at = now(), sign_method = 'in_person_canvas',
           signed_pdf_url = COALESCE($2, signed_pdf_url)
       WHERE id = $1 RETURNING *`,
      [req.params.id, signedPdfUrl]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record in-person signature' });
  }
});

module.exports = router;
