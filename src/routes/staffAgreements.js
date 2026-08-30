const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { uploadPdfBuffer } = require('../utils/cloudinary');
const { generateSignedAgreementPdf } = require('../utils/generateAgreementPdf');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /staff-agreements/templates — everyone can see the active handbook(s)
router.get('/templates', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM staff_agreement_templates WHERE is_active = true ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch handbook templates' });
  }
});

// POST /staff-agreements/templates — admin only, add/replace the employee handbook.
// Creating a new template automatically creates a pending staff_agreements row
// for every active staff member, so everyone has something to sign.
router.post('/templates', requireAdmin, async (req, res) => {
  const { title, version, content_url } = req.body;
  if (!title || !version) return res.status(400).json({ error: 'title and version are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const templateResult = await client.query(
      `INSERT INTO staff_agreement_templates (title, version, content_url) VALUES ($1,$2,$3) RETURNING *`,
      [title, version, content_url || null]
    );
    const template = templateResult.rows[0];

    const staffResult = await client.query(`SELECT id FROM staff WHERE is_active = true`);
    for (const s of staffResult.rows) {
      await client.query(
        `INSERT INTO staff_agreements (template_id, staff_id) VALUES ($1,$2)
         ON CONFLICT (template_id, staff_id) DO NOTHING`,
        [template.id, s.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(template);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create handbook template' });
  } finally {
    client.release();
  }
});

// GET /staff-agreements/my — the logged-in staff member's own agreements (any status)
router.get('/my', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sa.*, t.title, t.version
       FROM staff_agreements sa JOIN staff_agreement_templates t ON sa.template_id = t.id
       WHERE sa.staff_id = $1
       ORDER BY sa.created_at DESC`,
      [req.staff.staff_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your agreements' });
  }
});

// GET /staff-agreements/signed — admin only, every SIGNED staff agreement across
// everyone, for the admin-wide Documents view (as opposed to /my, which is
// scoped to the logged-in user and includes pending ones too).
router.get('/signed', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sa.*, t.title, t.version, s.first_name, s.last_name
       FROM staff_agreements sa
       JOIN staff_agreement_templates t ON sa.template_id = t.id
       JOIN staff s ON sa.staff_id = s.id
       WHERE sa.status = 'signed'
       ORDER BY sa.signed_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch signed staff agreements' });
  }
});

// GET /staff-agreements/:templateId/status — admin only, who has/hasn't signed a given handbook
router.get('/:templateId(\\d+)/status', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.first_name, s.last_name, sa.status, sa.signed_at
       FROM staff s
       LEFT JOIN staff_agreements sa ON sa.staff_id = s.id AND sa.template_id = $1
       WHERE s.is_active = true
       ORDER BY (sa.status = 'signed') ASC, s.last_name`,
      [req.params.templateId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch signing status' });
  }
});

// POST /staff-agreements/:id/sign — the logged-in staff member signs their own
// pending agreement. :id here is the staff_agreements row id.
router.post('/:id(\\d+)/sign', requireAuth, async (req, res) => {
  const { signature_data } = req.body;
  if (!signature_data) return res.status(400).json({ error: 'signature_data is required' });

  try {
    const result = await pool.query(
      `SELECT sa.*, t.title, s.first_name, s.last_name
       FROM staff_agreements sa
       JOIN staff_agreement_templates t ON sa.template_id = t.id
       JOIN staff s ON sa.staff_id = s.id
       WHERE sa.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Agreement not found' });
    const agreement = result.rows[0];

    // A staff member can only sign their own agreement, never someone else's —
    // admins included, since this is a personal acknowledgment, not something
    // that can be signed on another person's behalf.
    if (agreement.staff_id !== req.staff.staff_id) {
      return res.status(403).json({ error: 'You can only sign your own agreements' });
    }
    if (agreement.status === 'signed') {
      return res.status(400).json({ error: 'This has already been signed' });
    }

    const signerName = `${agreement.first_name} ${agreement.last_name}`;
    const signedAtISO = new Date().toISOString();

    let signedPdfUrl = null;
    try {
      const pdfBuffer = await generateSignedAgreementPdf({
        title: agreement.title,
        signerName,
        signedAtISO,
        signatureDataUri: signature_data,
      });
      signedPdfUrl = await uploadPdfBuffer(
        pdfBuffer,
        `staff-agreement-${agreement.id}-${Date.now()}`,
        'little-playhut/signed-staff-agreements'
      );
    } catch (pdfErr) {
      console.error('Signed staff agreement PDF generation/upload failed:', pdfErr);
    }

    const updated = await pool.query(
      `UPDATE staff_agreements
       SET status = 'signed', signature_data = $2, signed_at = now(), signed_pdf_url = COALESCE($3, signed_pdf_url)
       WHERE id = $1 RETURNING *`,
      [req.params.id, signature_data, signedPdfUrl]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to sign agreement' });
  }
});

module.exports = router;
