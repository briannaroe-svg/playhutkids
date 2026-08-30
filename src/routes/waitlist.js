const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

const VALID_ROOMS = [
  'Little Bunnies', 'Little Raccoons', 'Little Cubs',
  '3 Year Old Preschool-AM', '3 Year Old Preschool-PM',
  '4 Year Old Preschool-AM', '4 Year Old Preschool-PM', 'Wolf Den',
];

// GET /waitlist?status=waiting
router.get('/', async (req, res) => {
  const { status } = req.query;
  try {
    const query = status
      ? `SELECT * FROM waitlist_entries WHERE status = $1 ORDER BY created_at ASC`
      : `SELECT * FROM waitlist_entries ORDER BY created_at ASC`;
    const params = status ? [status] : [];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch waitlist' });
  }
});

// POST /waitlist — log a new inquiry
router.post('/', async (req, res) => {
  const {
    parent_name, parent_email, parent_phone,
    child_first_name, child_last_name, child_date_of_birth,
    interested_room, notes,
  } = req.body;

  if (!parent_name || !parent_email) {
    return res.status(400).json({ error: 'parent_name and parent_email are required' });
  }
  if (interested_room && !VALID_ROOMS.includes(interested_room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO waitlist_entries
        (parent_name, parent_email, parent_phone, child_first_name, child_last_name,
         child_date_of_birth, interested_room, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [parent_name, parent_email, parent_phone || null, child_first_name || null, child_last_name || null,
       child_date_of_birth || null, interested_room || null, notes || null, req.staff.staff_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add waitlist entry' });
  }
});

// PUT /waitlist/:id — edit an entry
router.put('/:id(\\d+)', async (req, res) => {
  const allowedFields = [
    'parent_name', 'parent_email', 'parent_phone',
    'child_first_name', 'child_last_name', 'child_date_of_birth',
    'interested_room', 'notes',
  ];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  if (updates.interested_room && !VALID_ROOMS.includes(updates.interested_room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  const fieldNames = Object.keys(updates);
  const setClauses = fieldNames.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = fieldNames.map((key) => updates[key]);

  try {
    const result = await pool.query(
      `UPDATE waitlist_entries SET ${setClauses} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Waitlist entry not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update waitlist entry' });
  }
});

// DELETE /waitlist/:id — remove an entry (e.g. family is no longer interested)
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM waitlist_entries WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Waitlist entry not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove waitlist entry' });
  }
});

module.exports = router;
