const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get('/', async (req, res) => {
  const { active } = req.query;
  try {
    const query = active === 'true'
      ? `SELECT id, first_name, last_name, email, phone, role, hourly_rate, is_active, hired_date FROM staff WHERE is_active = true ORDER BY last_name`
      : `SELECT id, first_name, last_name, email, phone, role, hourly_rate, is_active, hired_date FROM staff ORDER BY last_name`;
    const result = await pool.query(query);
    res.json(result.rows);
    // Note: pin_code intentionally excluded from list responses
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, email, phone, role, hourly_rate, is_active, hired_date
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
  const { first_name, last_name, email, phone, role, hourly_rate, pin_code, hired_date } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO staff (first_name, last_name, email, phone, role, hourly_rate, pin_code, hired_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, first_name, last_name, email, phone, role, hourly_rate, hired_date`,
      [first_name, last_name, email, phone, role, hourly_rate, pin_code, hired_date]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create staff member' });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  const fields = req.body;
  const setClauses = Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = Object.values(fields);
  try {
    const result = await pool.query(
      `UPDATE staff SET ${setClauses} WHERE id = $1
       RETURNING id, first_name, last_name, email, phone, role, hourly_rate, is_active, hired_date`,
      [req.params.id, ...values]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staff member not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

module.exports = router;
