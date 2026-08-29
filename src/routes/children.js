const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /children/search?q=...  (must come before /:id so it isn't shadowed)
router.get('/search', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM children WHERE first_name ILIKE $1 OR last_name ILIKE $1 ORDER BY last_name`,
      [`%${q || ''}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search children' });
  }
});

// GET /children  — full roster, optional ?status=active
router.get('/', async (req, res) => {
  const { status } = req.query;
  try {
    const query = status
      ? `SELECT * FROM children WHERE enrollment_status = $1 ORDER BY last_name`
      : `SELECT * FROM children ORDER BY last_name`;
    const params = status ? [status] : [];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch children' });
  }
});

// GET /children/:id  — numeric guard so it doesn't shadow other routes
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM children WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Child not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch child' });
  }
});

// POST /children  — new registration
router.post('/', async (req, res) => {
  const {
    family_id, first_name, last_name, date_of_birth, program,
    enrollment_date, allergies, medical_notes,
    emergency_contact_name, emergency_contact_phone, base_tuition_rate,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO children
        (family_id, first_name, last_name, date_of_birth, program, enrollment_date,
         allergies, medical_notes, emergency_contact_name, emergency_contact_phone, base_tuition_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [family_id, first_name, last_name, date_of_birth, program, enrollment_date,
       allergies, medical_notes, emergency_contact_name, emergency_contact_phone, base_tuition_rate]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register child' });
  }
});

// PUT /children/:id  — update record
router.put('/:id(\\d+)', async (req, res) => {
  const fields = req.body;
  const setClauses = Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = Object.values(fields);

  try {
    const result = await pool.query(
      `UPDATE children SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Child not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update child' });
  }
});

// PUT /children/:id/withdraw
router.put('/:id(\\d+)/withdraw', async (req, res) => {
  const { withdrawal_date } = req.body;
  try {
    const result = await pool.query(
      `UPDATE children SET enrollment_status = 'withdrawn', withdrawal_date = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, withdrawal_date || new Date().toISOString().slice(0, 10)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to withdraw child' });
  }
});

module.exports = router;
