const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const { hashPassword } = require('../utils/auth');

router.use(requireAdmin);

router.get('/', async (req, res) => {
  const { active } = req.query;
  try {
    const query = active === 'true'
      ? `SELECT id, first_name, last_name, email, phone, role, hourly_rate, access_level, is_active, hired_date FROM staff WHERE is_active = true ORDER BY last_name`
      : `SELECT id, first_name, last_name, email, phone, role, hourly_rate, access_level, is_active, hired_date FROM staff ORDER BY last_name`;
    const result = await pool.query(query);
    res.json(result.rows);
    // Note: pin_code and password_hash intentionally excluded from list responses
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, email, phone, role, hourly_rate, access_level, is_active, hired_date
       FROM staff WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staff member not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch staff member' });
  }
});

router.post('/', async (req, res) => {
  const { first_name, last_name, email, phone, role, hourly_rate, pin_code, hired_date, password, access_level } = req.body;

  if (!first_name || !last_name || !email) {
    return res.status(400).json({ error: 'first_name, last_name, and email are required' });
  }

  const validAccessLevels = ['staff', 'admin'];
  const resolvedAccessLevel = validAccessLevels.includes(access_level) ? access_level : 'staff';

  try {
    const passwordHash = password ? await hashPassword(password) : null;

    const result = await pool.query(
      `INSERT INTO staff (first_name, last_name, email, phone, role, hourly_rate, pin_code, hired_date, password_hash, access_level)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, first_name, last_name, email, phone, role, hourly_rate, hired_date, access_level`,
      [first_name, last_name, email, phone, role, hourly_rate, pin_code, hired_date, passwordHash, resolvedAccessLevel]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') { // unique_violation, e.g. duplicate email
      return res.status(409).json({ error: 'A staff member with that email already exists' });
    }
    res.status(500).json({ error: 'Failed to create staff member' });
  }
});

// PUT /staff/:id — update a staff member's profile fields.
// Deliberately allowlisted rather than accepting arbitrary keys from the request
// body: this prevents a caller from setting password_hash directly (bypassing
// hashing) or access_level without going through resolvedAccessLevel validation.
// To change a password, send `password` (plaintext) — it gets hashed here.
// To change access_level, it must be exactly 'staff' or 'admin'.
router.put('/:id(\\d+)', async (req, res) => {
  const allowedFields = ['first_name', 'last_name', 'email', 'phone', 'role', 'hourly_rate', 'pin_code', 'hired_date', 'is_active'];
  const updates = {};

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (req.body.access_level !== undefined) {
    if (!['staff', 'admin'].includes(req.body.access_level)) {
      return res.status(400).json({ error: "access_level must be 'staff' or 'admin'" });
    }
    updates.access_level = req.body.access_level;
  }

  if (req.body.password) {
    updates.password_hash = await hashPassword(req.body.password);
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  const fieldNames = Object.keys(updates);
  const setClauses = fieldNames.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = fieldNames.map((key) => updates[key]);

  try {
    const result = await pool.query(
      `UPDATE staff SET ${setClauses} WHERE id = $1
       RETURNING id, first_name, last_name, email, phone, role, hourly_rate, is_active, hired_date, access_level`,
      [req.params.id, ...values]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staff member not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A staff member with that email already exists' });
    }
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

module.exports = router;
