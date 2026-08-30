const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /schedule-events/unacknowledged — events the logged-in staff member has
// NOT yet acknowledged (must come before /:id). Drives the login popup queue.
router.get('/unacknowledged', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.* FROM schedule_events e
       WHERE NOT EXISTS (
         SELECT 1 FROM event_acknowledgments ea WHERE ea.event_id = e.id AND ea.staff_id = $1
       )
       ORDER BY e.event_date ASC`,
      [req.staff.staff_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch unacknowledged events' });
  }
});

// POST /schedule-events/:id/acknowledge — the logged-in staff member acknowledges an event
router.post('/:id(\\d+)/acknowledge', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO event_acknowledgments (event_id, staff_id) VALUES ($1,$2)
       ON CONFLICT (event_id, staff_id) DO NOTHING`,
      [req.params.id, req.staff.staff_id]
    );
    res.status(201).json({ acknowledged: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to acknowledge event' });
  }
});

// GET /schedule-events/:id/acknowledgments — admin only, who has/hasn't acknowledged
router.get('/:id(\\d+)/acknowledgments', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.first_name, s.last_name, ea.acknowledged_at
       FROM staff s
       LEFT JOIN event_acknowledgments ea ON ea.staff_id = s.id AND ea.event_id = $1
       WHERE s.is_active = true
       ORDER BY (ea.acknowledged_at IS NULL) ASC, s.last_name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch acknowledgment status' });
  }
});

// GET /schedule-events?start=&end=  — visible to everyone (admin and staff)
router.get('/', requireAuth, async (req, res) => {
  const { start, end } = req.query;
  try {
    let query = `SELECT * FROM schedule_events WHERE 1=1`;
    const params = [];
    if (start) { params.push(start); query += ` AND event_date >= $${params.length}`; }
    if (end) { params.push(end); query += ` AND event_date <= $${params.length}`; }
    query += ` ORDER BY event_date ASC, start_time ASC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch schedule events' });
  }
});

// POST /schedule-events — admin only
router.post('/', requireAdmin, async (req, res) => {
  const { title, description, event_date, start_time, end_time } = req.body;
  if (!title || !event_date) return res.status(400).json({ error: 'title and event_date are required' });
  try {
    const result = await pool.query(
      `INSERT INTO schedule_events (title, description, event_date, start_time, end_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [title, description || null, event_date, start_time || null, end_time || null, req.staff.staff_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create schedule event' });
  }
});

// PUT /schedule-events/:id — admin only
router.put('/:id(\\d+)', requireAdmin, async (req, res) => {
  const { title, description, event_date, start_time, end_time } = req.body;
  try {
    const result = await pool.query(
      `UPDATE schedule_events
       SET title = COALESCE($2, title), description = COALESCE($3, description),
           event_date = COALESCE($4, event_date), start_time = $5, end_time = $6
       WHERE id = $1 RETURNING *`,
      [req.params.id, title, description, event_date, start_time || null, end_time || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update schedule event' });
  }
});

// DELETE /schedule-events/:id — admin only
router.delete('/:id(\\d+)', requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM schedule_events WHERE id = $1`, [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete schedule event' });
  }
});

module.exports = router;
