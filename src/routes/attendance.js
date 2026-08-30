const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /attendance/today — today's check-in status for every child the requester can see.
// Admin: every enrolled child. Staff: only children assigned to them.
// A child is "checked in" if they have an attendance_records row for today with no checked_out_at.
router.get('/today', requireAuth, async (req, res) => {
  const isAdmin = req.staff.access_level === 'admin';
  try {
    let query;
    const params = [];

    if (isAdmin) {
      query = `
        SELECT c.id AS child_id, c.first_name, c.last_name, c.program,
               ar.id AS attendance_id, ar.checked_in_at, ar.checked_out_at
        FROM children c
        LEFT JOIN attendance_records ar
          ON ar.child_id = c.id AND ar.checked_in_at::date = CURRENT_DATE
        WHERE c.enrollment_status = 'active'
        ORDER BY c.last_name, c.first_name`;
    } else {
      params.push(req.staff.staff_id);
      query = `
        SELECT c.id AS child_id, c.first_name, c.last_name, c.program,
               ar.id AS attendance_id, ar.checked_in_at, ar.checked_out_at
        FROM children c
        JOIN child_staff_assignments csa ON csa.child_id = c.id AND csa.staff_id = $1
        LEFT JOIN attendance_records ar
          ON ar.child_id = c.id AND ar.checked_in_at::date = CURRENT_DATE
        WHERE c.enrollment_status = 'active'
        ORDER BY c.last_name, c.first_name`;
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch today\'s attendance' });
  }
});

// POST /attendance/:childId/check-in
router.post('/:childId(\\d+)/check-in', requireAuth, async (req, res) => {
  const { childId } = req.params;
  try {
    // Non-admins can only check in children assigned to them.
    if (req.staff.access_level !== 'admin') {
      const assigned = await pool.query(
        `SELECT 1 FROM child_staff_assignments WHERE child_id = $1 AND staff_id = $2`,
        [childId, req.staff.staff_id]
      );
      if (assigned.rows.length === 0) {
        return res.status(403).json({ error: 'This child is not assigned to you' });
      }
    }

    const openToday = await pool.query(
      `SELECT * FROM attendance_records
       WHERE child_id = $1 AND checked_in_at::date = CURRENT_DATE AND checked_out_at IS NULL`,
      [childId]
    );
    if (openToday.rows.length > 0) {
      return res.status(400).json({ error: 'Already checked in today', record: openToday.rows[0] });
    }

    const result = await pool.query(
      `INSERT INTO attendance_records (child_id, checked_in_at, checked_in_by)
       VALUES ($1, now(), $2) RETURNING *`,
      [childId, req.staff.staff_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check in' });
  }
});

// POST /attendance/:childId/check-out
router.post('/:childId(\\d+)/check-out', requireAuth, async (req, res) => {
  const { childId } = req.params;
  try {
    if (req.staff.access_level !== 'admin') {
      const assigned = await pool.query(
        `SELECT 1 FROM child_staff_assignments WHERE child_id = $1 AND staff_id = $2`,
        [childId, req.staff.staff_id]
      );
      if (assigned.rows.length === 0) {
        return res.status(403).json({ error: 'This child is not assigned to you' });
      }
    }

    const openToday = await pool.query(
      `SELECT * FROM attendance_records
       WHERE child_id = $1 AND checked_in_at::date = CURRENT_DATE AND checked_out_at IS NULL
       ORDER BY checked_in_at DESC LIMIT 1`,
      [childId]
    );
    if (openToday.rows.length === 0) {
      return res.status(400).json({ error: 'This child is not currently checked in' });
    }

    const result = await pool.query(
      `UPDATE attendance_records SET checked_out_at = now(), checked_out_by = $2
       WHERE id = $1 RETURNING *`,
      [openToday.rows[0].id, req.staff.staff_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check out' });
  }
});

// GET /attendance/history?child_id=&start=&end=  — admin only, full historical log
router.get('/history', requireAdmin, async (req, res) => {
  const { child_id, start, end } = req.query;
  try {
    let query = `
      SELECT ar.*, c.first_name, c.last_name
      FROM attendance_records ar
      JOIN children c ON ar.child_id = c.id
      WHERE 1=1`;
    const params = [];
    if (child_id) { params.push(child_id); query += ` AND ar.child_id = $${params.length}`; }
    if (start) { params.push(start); query += ` AND ar.checked_in_at >= $${params.length}`; }
    if (end) { params.push(end); query += ` AND ar.checked_in_at <= $${params.length}`; }
    query += ` ORDER BY ar.checked_in_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch attendance history' });
  }
});

module.exports = router;
