const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const VALID_ROOMS = [
  'Little Bunnies',
  'Little Raccoons',
  'Little Cubs',
  '3 Year Old Preschool-AM',
  '3 Year Old Preschool-PM',
  '4 Year Old Preschool-AM',
  '4 Year Old Preschool-PM',
  'Wolf Den',
];

// GET /children/rooms — the fixed list of room options, for populating a dropdown
router.get('/rooms', requireAuth, async (req, res) => {
  res.json(VALID_ROOMS);
});

// GET /children/search?q=...  (must come before /:id so it isn't shadowed) — admin only
router.get('/search', requireAdmin, async (req, res) => {
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

// GET /children  — full roster, optional ?status=active. Any authenticated staff
// member can see the roster (children are grouped by room now, not assigned to
// individual staff — everyone floats until room-based staff assignment exists).
// Admin gets the full record including family_id; staff gets everything except
// parent/family contact fields, matching the same exclusion GET /:id already did.
router.get('/', requireAuth, async (req, res) => {
  const { status } = req.query;
  const isAdmin = req.staff.access_level === 'admin';
  try {
    const columns = isAdmin
      ? 'c.*'
      : `c.id, c.first_name, c.last_name, c.date_of_birth, c.program, c.room, c.enrollment_status,
         c.allergies, c.medical_notes, c.emergency_contact_name, c.emergency_contact_phone`;
    const query = status
      ? `SELECT ${columns} FROM children c WHERE c.enrollment_status = $1 ORDER BY c.room, c.last_name`
      : `SELECT ${columns} FROM children c ORDER BY c.room, c.last_name`;
    const params = status ? [status] : [];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch children' });
  }
});

// GET /children/:id  — numeric guard so it doesn't shadow other routes.
// Admin: full record including family contact info. Staff: everything except
// family/parent contact fields — excluded from the query itself, not just
// hidden client-side, so that data never leaves the server for a non-admin request.
router.get('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    if (req.staff.access_level !== 'admin') {
      const result = await pool.query(
        `SELECT id, first_name, last_name, date_of_birth, program, room, enrollment_status,
                allergies, medical_notes, emergency_contact_name, emergency_contact_phone
         FROM children WHERE id = $1`,
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Child not found' });
      return res.json(result.rows[0]);
    }

    const result = await pool.query(`SELECT * FROM children WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Child not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch child' });
  }
});

// POST /children  — new registration — admin only
router.post('/', requireAdmin, async (req, res) => {
  const {
    family_id, first_name, last_name, date_of_birth, program, room,
    enrollment_date, allergies, medical_notes,
    emergency_contact_name, emergency_contact_phone, base_tuition_rate,
  } = req.body;

  if (room && !VALID_ROOMS.includes(room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO children
        (family_id, first_name, last_name, date_of_birth, program, room, enrollment_date,
         allergies, medical_notes, emergency_contact_name, emergency_contact_phone, base_tuition_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [family_id, first_name, last_name, date_of_birth, program, room || null, enrollment_date,
       allergies, medical_notes, emergency_contact_name, emergency_contact_phone, base_tuition_rate]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register child' });
  }
});

// PUT /children/:id  — update record — admin only
router.put('/:id(\\d+)', requireAdmin, async (req, res) => {
  const fields = req.body;

  if (fields.room !== undefined && fields.room !== null && !VALID_ROOMS.includes(fields.room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }

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

// PUT /children/:id/withdraw — admin only
router.put('/:id(\\d+)/withdraw', requireAdmin, async (req, res) => {
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
