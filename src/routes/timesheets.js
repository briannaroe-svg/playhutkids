const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// POST /timesheets/clock-in — staff clocks in via PIN
router.post('/clock-in', async (req, res) => {
  const { staff_id, pin_code } = req.body;
  try {
    const staff = await pool.query(`SELECT * FROM staff WHERE id = $1 AND pin_code = $2 AND is_active = true`, [staff_id, pin_code]);
    if (staff.rows.length === 0) return res.status(401).json({ error: 'Invalid staff ID or PIN' });

    // Guard against double clock-in: check for an open entry
    const openEntry = await pool.query(
      `SELECT * FROM timesheet_entries WHERE staff_id = $1 AND clock_out IS NULL`,
      [staff_id]
    );
    if (openEntry.rows.length > 0) {
      return res.status(400).json({ error: 'Already clocked in', entry: openEntry.rows[0] });
    }

    const result = await pool.query(
      `INSERT INTO timesheet_entries (staff_id, clock_in) VALUES ($1, now()) RETURNING *`,
      [staff_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

// POST /timesheets/clock-out
router.post('/clock-out', async (req, res) => {
  const { staff_id, pin_code } = req.body;
  try {
    const staff = await pool.query(`SELECT * FROM staff WHERE id = $1 AND pin_code = $2`, [staff_id, pin_code]);
    if (staff.rows.length === 0) return res.status(401).json({ error: 'Invalid staff ID or PIN' });

    const openEntry = await pool.query(
      `SELECT * FROM timesheet_entries WHERE staff_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,
      [staff_id]
    );
    if (openEntry.rows.length === 0) return res.status(400).json({ error: 'No open clock-in found' });

    const entry = openEntry.rows[0];
    const result = await pool.query(
      `UPDATE timesheet_entries
       SET clock_out = now(), total_hours = ROUND(EXTRACT(EPOCH FROM (now() - clock_in)) / 3600.0, 2)
       WHERE id = $1 RETURNING *`,
      [entry.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clock out' });
  }
});

// GET /timesheets?staff_id=&start=&end=  — for attendance review or future payroll export
router.get('/', async (req, res) => {
  const { staff_id, start, end } = req.query;
  try {
    let query = `SELECT * FROM timesheet_entries WHERE 1=1`;
    const params = [];
    if (staff_id) { params.push(staff_id); query += ` AND staff_id = $${params.length}`; }
    if (start) { params.push(start); query += ` AND clock_in >= $${params.length}`; }
    if (end) { params.push(end); query += ` AND clock_in <= $${params.length}`; }
    query += ` ORDER BY clock_in DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch timesheet entries' });
  }
});

// PUT /timesheets/:id — manual correction by a manager
router.put('/:id(\\d+)', async (req, res) => {
  const { clock_in, clock_out, notes, edited_by } = req.body;
  try {
    const result = await pool.query(
      `UPDATE timesheet_entries
       SET clock_in = COALESCE($2, clock_in),
           clock_out = COALESCE($3, clock_out),
           total_hours = CASE WHEN $3 IS NOT NULL THEN ROUND(EXTRACT(EPOCH FROM ($3::timestamptz - COALESCE($2::timestamptz, clock_in))) / 3600.0, 2) ELSE total_hours END,
           notes = COALESCE($4, notes),
           edited_by = $5,
           edited_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, clock_in, clock_out, notes, edited_by]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update timesheet entry' });
  }
});

module.exports = router;
