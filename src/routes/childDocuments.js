const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { uploadBase64File } = require('../utils/cloudinary');

const VALID_DOCUMENT_TYPES = ['Immunizations', 'Physical/Health Form', 'Emergency Contact Form'];

// GET /child-documents/expiring?days=30 — admin only, everything expired or
// expiring within the window, for the Home page list. Must come before the
// /:childId route below since both are otherwise ambiguous as GET /child-documents/*.
router.get('/expiring', requireAdmin, async (req, res) => {
  const days = Number(req.query.days) || 30;
  try {
    const result = await pool.query(
      `SELECT cd.*, c.first_name, c.last_name
       FROM child_documents cd
       JOIN children c ON cd.child_id = c.id
       WHERE cd.expiration_date IS NOT NULL
         AND cd.expiration_date <= (CURRENT_DATE + ($1 || ' days')::interval)
         AND c.enrollment_status = 'active'
       ORDER BY cd.expiration_date ASC`,
      [days]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch expiring documents' });
  }
});

// GET /child-documents/:childId — every document on file for one child (any staff)
router.get('/:childId(\\d+)', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM child_documents WHERE child_id = $1 ORDER BY document_type`,
      [req.params.childId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// POST /child-documents/:childId — admin only, upload/replace a document
router.post('/:childId(\\d+)', requireAdmin, async (req, res) => {
  const { document_type, expiration_date, file_data } = req.body;

  if (!document_type || !VALID_DOCUMENT_TYPES.includes(document_type)) {
    return res.status(400).json({ error: 'Invalid document_type' });
  }
  if (!file_data) return res.status(400).json({ error: 'file_data is required' });

  try {
    const fileUrl = await uploadBase64File(
      file_data,
      `child-${req.params.childId}-${document_type.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`,
      'little-playhut/child-documents'
    );

    const result = await pool.query(
      `INSERT INTO child_documents (child_id, document_type, file_url, expiration_date, uploaded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.childId, document_type, fileUrl, expiration_date || null, req.staff.staff_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

// DELETE /child-documents/:id — admin only, remove a document record
router.delete('/:id(\\d+)', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM child_documents WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Document not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove document' });
  }
});

module.exports = router;
