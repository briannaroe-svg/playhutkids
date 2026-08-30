const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /shifts/my-schedule?start=&end=  — staff's own shifts (must come before /:id)
router.get('/my-schedule', requireAuth, async (req, res) => {
  const { start, end } = req.query;
  try {
    let query = `SELECT * FROM shifts WHERE staff_id = $1`;
    const params = [req.staff.staff_id];
    if (start) { params.push(start); query += ` AND shift_date >= $${params.length}`; }
    if (end) { params.push(end); query += ` AND shift_date <= $${params.length}`; }
    query += ` ORDER BY shift_date ASC, start_time ASC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your schedule' });
  }
});

// GET /shifts?start=&end=&staff_id=  — admin only, full schedule across everyone
router.get('/', requireAdmin, async (req, res) => {
  const { start, end, staff_id } = req.query;
  try {
    let query = `
      SELECT sh.*, s.first_name, s.last_name
      FROM shifts sh JOIN staff s ON sh.staff_id = s.id
      WHERE 1=1`;
    const params = [];
    if (start) { params.push(start); query += ` AND sh.shift_date >= $${params.length}`; }
    if (end) { params.push(end); query += ` AND sh.shift_date <= $${params.length}`; }
    if (staff_id) { params.push(staff_id); query += ` AND sh.staff_id = $${params.length}`; }
    query += ` ORDER BY sh.shift_date ASC, sh.start_time ASC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shifts' });
  }
});

// POST /shifts — admin only, assign a staff member to a date/time
router.post('/', requireAdmin, async (req, res) => {
  const { staff_id, shift_date, start_time, end_time, notes } = req.body;
  if (!staff_id || !shift_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'staff_id, shift_date, start_time, and end_time are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO shifts (staff_id, shift_date, start_time, end_time, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [staff_id, shift_date, start_time, end_time, notes || null, req.staff.staff_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create shift' });
  }
});

// PUT /shifts/:id — admin only
router.put('/:id(\\d+)', requireAdmin, async (req, res) => {
  const { shift_date, start_time, end_time, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE shifts
       SET shift_date = COALESCE($2, shift_date),
           start_time = COALESCE($3, start_time),
           end_time = COALESCE($4, end_time),
           notes = COALESCE($5, notes),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, shift_date, start_time, end_time, notes]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update shift' });
  }
});

// DELETE /shifts/:id — admin only
router.delete('/:id(\\d+)', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM shifts WHERE id = $1`, [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

module.exports = router;
