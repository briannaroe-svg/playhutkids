const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /attendance/today — today's check-in status for every active child.
// Everyone (admin and staff) sees every child — children are grouped by room
// now, not assigned to individual staff, and staff currently "float" across
// rooms, so there's no per-user filtering here yet.
// A child is "checked in" if they have an attendance_records row for today with no checked_out_at.
router.get('/today', requireAuth, async (req, res) => {
  try {
    // Uses LEFT JOIN LATERAL to pick only the MOST RECENT attendance_records row
    // per child for today. Without this, a child checked in/out more than once
    // in one day (leaves early, comes back, etc.) would return multiple rows
    // for the same child, and the frontend could end up displaying a stale
    // record instead of the current one.
    const result = await pool.query(
      `SELECT c.id AS child_id, c.first_name, c.last_name, c.program, c.room,
              ar.id AS attendance_id, ar.checked_in_at, ar.checked_out_at
       FROM children c
       LEFT JOIN LATERAL (
         SELECT * FROM attendance_records
         WHERE child_id = c.id AND checked_in_at::date = CURRENT_DATE
         ORDER BY checked_in_at DESC
         LIMIT 1
       ) ar ON true
       WHERE c.enrollment_status = 'active'
       ORDER BY c.room, c.last_name, c.first_name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch today\'s attendance' });
  }
});

// GET /attendance/ratios — live licensing ratio status per room, based on
// Idaho's IDAPA 16.06.02 points system: each currently-checked-in child
// contributes points based on their age today, and the room's total points
// divide by 12 (max points per staff) to get required staff. That's compared
// against how many currently-clocked-in staff have set this room as their
// current_room (see POST /timesheets/set-room). This is informational only —
// it does not block check-ins — admin reviews it and staffs accordingly.
router.get('/ratios', requireAuth, async (req, res) => {
  try {
    const childrenResult = await pool.query(
      `SELECT c.room, c.date_of_birth
       FROM children c
       JOIN attendance_records ar ON ar.child_id = c.id
       WHERE ar.checked_in_at::date = CURRENT_DATE AND ar.checked_out_at IS NULL
         AND c.enrollment_status = 'active' AND c.room IS NOT NULL`
    );

    const staffResult = await pool.query(
      `SELECT current_room, COUNT(*) AS staff_count
       FROM timesheet_entries
       WHERE clock_out IS NULL AND current_room IS NOT NULL
       GROUP BY current_room`
    );
    const staffByRoom = {};
    staffResult.rows.forEach(r => { staffByRoom[r.current_room] = Number(r.staff_count); });

    // IDAPA 16.06.02 points: under 24mo = 2, 24-36mo = 1.5, 36mo-5yr = 1, 5-13yr = 0.5.
    // Verify against the current regulation text before relying on this for
    // an actual inspection — ratios are compiled from a secondary source and
    // should be double-checked against Idaho DHW directly.
    const pointsForAge = (dob) => {
      const ageMonths = (Date.now() - new Date(dob).getTime()) / (1000 * 60 * 60 * 24 * 30.4375);
      if (ageMonths < 24) return 2;
      if (ageMonths < 36) return 1.5;
      if (ageMonths < 60) return 1;
      return 0.5; // 5–13 years; children older than 13 are not expected in this system
    };

    const pointsByRoom = {};
    childrenResult.rows.forEach(c => {
      pointsByRoom[c.room] = (pointsByRoom[c.room] || 0) + pointsForAge(c.date_of_birth);
    });

    const MAX_POINTS_PER_STAFF = 12;
    const rooms = new Set([...Object.keys(pointsByRoom), ...Object.keys(staffByRoom)]);
    const ratios = [...rooms].map(room => {
      const points = pointsByRoom[room] || 0;
      const staffPresent = staffByRoom[room] || 0;
      const staffRequired = Math.ceil(points / MAX_POINTS_PER_STAFF);
      return {
        room,
        checked_in_points: Math.round(points * 100) / 100,
        staff_present: staffPresent,
        staff_required: staffRequired,
        in_compliance: staffPresent >= staffRequired,
      };
    });

    res.json(ratios);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate ratios' });
  }
});


router.post('/:childId(\\d+)/check-in', requireAuth, async (req, res) => {
  const { childId } = req.params;
  try {
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

// POST /attendance/:childId/check-out — any authenticated staff member can check out any child
router.post('/:childId(\\d+)/check-out', requireAuth, async (req, res) => {
  const { childId } = req.params;
  try {
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
