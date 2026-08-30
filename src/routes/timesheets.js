const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { generateTimesheetPdf } = require('../utils/generateTimesheetPdf');

// POST /timesheets/clock-in — the logged-in staff member clocks themselves in.
// No PIN needed: they're already authenticated via the dashboard session.
router.post('/clock-in', requireAuth, async (req, res) => {
  const staffId = req.staff.staff_id;
  try {
    const openEntry = await pool.query(
      `SELECT * FROM timesheet_entries WHERE staff_id = $1 AND clock_out IS NULL`,
      [staffId]
    );
    if (openEntry.rows.length > 0) {
      return res.status(400).json({ error: 'Already clocked in', entry: openEntry.rows[0] });
    }

    const result = await pool.query(
      `INSERT INTO timesheet_entries (staff_id, clock_in) VALUES ($1, now()) RETURNING *`,
      [staffId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

// POST /timesheets/clock-out — the logged-in staff member clocks themselves out.
router.post('/clock-out', requireAuth, async (req, res) => {
  const staffId = req.staff.staff_id;
  try {
    const openEntry = await pool.query(
      `SELECT * FROM timesheet_entries WHERE staff_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,
      [staffId]
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

// GET /timesheets/my-status — is the logged-in user currently clocked in?
router.get('/my-status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM timesheet_entries WHERE staff_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,
      [req.staff.staff_id]
    );
    res.json({ clocked_in: result.rows.length > 0, entry: result.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch clock status' });
  }
});

// GET /timesheets/currently-clocked-in — admin only: everyone with an open entry right now
router.get('/currently-clocked-in', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT te.*, s.first_name, s.last_name
       FROM timesheet_entries te
       JOIN staff s ON te.staff_id = s.id
       WHERE te.clock_out IS NULL
       ORDER BY te.clock_in ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch currently clocked-in staff' });
  }
});

// GET /timesheets?staff_id=&start=&end=  — for attendance review or payroll export.
// Non-admin staff can only see their own entries, regardless of what staff_id
// they pass — the query param is overridden by their own token identity unless
// they're an admin. Includes staff name via join so the frontend doesn't need
// a separate lookup.
router.get('/', requireAuth, async (req, res) => {
  const { start, end } = req.query;
  const effectiveStaffId = req.staff.access_level === 'admin' ? req.query.staff_id : req.staff.staff_id;
  try {
    let query = `
      SELECT te.*, s.first_name, s.last_name
      FROM timesheet_entries te
      JOIN staff s ON te.staff_id = s.id
      WHERE 1=1`;
    const params = [];
    if (effectiveStaffId) { params.push(effectiveStaffId); query += ` AND te.staff_id = $${params.length}`; }
    if (start) { params.push(start); query += ` AND te.clock_in >= $${params.length}`; }
    if (end) { params.push(end); query += ` AND te.clock_in <= $${params.length}`; }
    query += ` ORDER BY te.clock_in DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch timesheet entries' });
  }
});

// GET /timesheets/pdf?staff_id=&start=&end=  — admin only: payroll-ready PDF for a date range.
// staff_id is optional — omit it to get everyone's entries in one PDF (grouped by person).
router.get('/pdf', requireAdmin, async (req, res) => {
  const { staff_id, start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end dates are required' });
  }

  try {
    let query = `
      SELECT te.*, s.first_name, s.last_name
      FROM timesheet_entries te
      JOIN staff s ON te.staff_id = s.id
      WHERE te.clock_in >= $1 AND te.clock_in <= $2`;
    const params = [start, end];
    if (staff_id) { params.push(staff_id); query += ` AND te.staff_id = $${params.length}`; }
    query += ` ORDER BY s.last_name, te.clock_in ASC`;

    const result = await pool.query(query, params);
    const pdfBuffer = await generateTimesheetPdf({ entries: result.rows, start, end });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="timesheets_${start}_to_${end}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate timesheet PDF' });
  }
});

// PUT /timesheets/:id — manual correction by a manager (admin only)
router.put('/:id(\\d+)', requireAdmin, async (req, res) => {
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

// DELETE /timesheets/:id — admin only, permanently removes a timesheet entry.
// Use with care — this is a real payroll record, not a soft-delete/deactivation.
router.delete('/:id(\\d+)', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM timesheet_entries WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete timesheet entry' });
  }
});

module.exports = router;
