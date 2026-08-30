const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /time-off/pending-count — admin only, for the sidebar badge (must come before /:id)
router.get('/pending-count', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) FROM time_off_requests WHERE status = 'pending'`);
    res.json({ count: Number(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch pending count' });
  }
});

// GET /time-off/my-requests — staff's own request history (must come before /:id)
router.get('/my-requests', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM time_off_requests WHERE staff_id = $1 ORDER BY requested_at DESC`,
      [req.staff.staff_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your time-off requests' });
  }
});

// GET /time-off?status=  — admin only, everyone's requests
router.get('/', requireAdmin, async (req, res) => {
  const { status } = req.query;
  try {
    let query = `
      SELECT t.*, s.first_name, s.last_name
      FROM time_off_requests t JOIN staff s ON t.staff_id = s.id
      WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); query += ` AND t.status = $${params.length}`; }
    query += ` ORDER BY t.requested_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch time-off requests' });
  }
});

// POST /time-off — any staff member submits a request. Shows up in the admin
// inbox and sidebar badge — no email involved.
router.post('/', requireAuth, async (req, res) => {
  const { start_date, end_date, reason } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date are required' });

  try {
    const result = await pool.query(
      `INSERT INTO time_off_requests (staff_id, start_date, end_date, reason)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.staff.staff_id, start_date, end_date, reason || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit time-off request' });
  }
});

// PUT /time-off/:id/review — admin only, approve or deny
router.put('/:id(\\d+)/review', requireAdmin, async (req, res) => {
  const { status, review_notes } = req.body;
  if (!['approved', 'denied'].includes(status)) {
    return res.status(400).json({ error: "status must be 'approved' or 'denied'" });
  }
  try {
    const result = await pool.query(
      `UPDATE time_off_requests
       SET status = $2, reviewed_by = $3, reviewed_at = now(), review_notes = $4
       WHERE id = $1 RETURNING *`,
      [req.params.id, status, req.staff.staff_id, review_notes || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to review time-off request' });
  }
});

module.exports = router;
