const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');

const VALID_ROOMS = [
  'Little Bunnies', 'Little Raccoons', 'Little Cubs',
  '3 Year Old Preschool-AM', '3 Year Old Preschool-PM',
  '4 Year Old Preschool-AM', '4 Year Old Preschool-PM', 'Wolf Den',
];

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
  const { staff_id, shift_date, start_time, end_time, notes, room } = req.body;
  if (!staff_id || !shift_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'staff_id, shift_date, start_time, and end_time are required' });
  }
  if (room && !VALID_ROOMS.includes(room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO shifts (staff_id, shift_date, start_time, end_time, notes, room, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [staff_id, shift_date, start_time, end_time, notes || null, room || null, req.staff.staff_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create shift' });
  }
});

// PUT /shifts/:id — admin only
router.put('/:id(\\d+)', requireAdmin, async (req, res) => {
  const { shift_date, start_time, end_time, notes, room } = req.body;
  if (room && !VALID_ROOMS.includes(room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }
  try {
    const result = await pool.query(
      `UPDATE shifts
       SET shift_date = COALESCE($2, shift_date),
           start_time = COALESCE($3, start_time),
           end_time = COALESCE($4, end_time),
           notes = COALESCE($5, notes),
           room = COALESCE($6, room),
           updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, shift_date, start_time, end_time, notes, room]
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

// POST /shifts/finalize-week — admin only. Finds every distinct staff member
// with a shift in the given week, emails each their own shifts for that
// week, emails admin a summary confirmation, and creates one pending in-app
// acknowledgment per staff member (same "must dismiss to continue" pattern
// as schedule_events/event_acknowledgments).
router.post('/finalize-week', requireAdmin, async (req, res) => {
  const { week_start, week_end } = req.body;
  if (!week_start || !week_end) return res.status(400).json({ error: 'week_start and week_end are required' });

  try {
    const shiftsResult = await pool.query(
      `SELECT sh.*, s.first_name, s.last_name, s.email
       FROM shifts sh JOIN staff s ON sh.staff_id = s.id
       WHERE sh.shift_date >= $1 AND sh.shift_date <= $2
       ORDER BY sh.shift_date ASC, sh.start_time ASC`,
      [week_start, week_end]
    );
    if (shiftsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No shifts scheduled for this week — nothing to finalize.' });
    }

    // Group shifts by staff member so each person's email lists only their own.
    const byStaff = {};
    for (const shift of shiftsResult.rows) {
      if (!byStaff[shift.staff_id]) {
        byStaff[shift.staff_id] = { staff_id: shift.staff_id, first_name: shift.first_name, last_name: shift.last_name, email: shift.email, shifts: [] };
      }
      byStaff[shift.staff_id].shifts.push(shift);
    }
    const staffList = Object.values(byStaff);

    const finalizationResult = await pool.query(
      `INSERT INTO schedule_finalizations (week_start, finalized_by, staff_notified_count)
       VALUES ($1,$2,$3) RETURNING *`,
      [week_start, req.staff.staff_id, staffList.length]
    );
    const finalization = finalizationResult.rows[0];

    const weekLabel = `${new Date(week_start + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${new Date(week_end + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;

    const formatTime = (t) => {
      const [h, m] = t.split(':');
      const hour = Number(h);
      const period = hour >= 12 ? 'PM' : 'AM';
      const displayHour = hour % 12 === 0 ? 12 : hour % 12;
      return `${displayHour}:${m} ${period}`;
    };

    let emailedCount = 0;
    for (const person of staffList) {
      // Record that this person is a recipient of this finalization — this is
      // what makes the notice "pending" for them (no ack row exists yet).
      await pool.query(
        `INSERT INTO schedule_finalization_recipients (finalization_id, staff_id)
         VALUES ($1, $2) ON CONFLICT (finalization_id, staff_id) DO NOTHING`,
        [finalization.id, person.staff_id]
      );

      if (person.email) {
        const shiftLines = person.shifts.map(s =>
          `<li>${new Date(s.shift_date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}: ${formatTime(s.start_time.slice(0,5))}–${formatTime(s.end_time.slice(0,5))}${s.room ? ' — ' + s.room : ''}</li>`
        ).join('');
        const sent = await sendEmail({
          to: [person.email],
          subject: `Your schedule for ${weekLabel} — The Little Playhut`,
          html: `<p>Hi ${person.first_name},</p><p>Your schedule for <strong>${weekLabel}</strong> has been finalized:</p><ul>${shiftLines}</ul><p>Thanks!</p>`,
        });
        if (sent) emailedCount++;
      }
    }

    // Confirmation to admin
    const adminEmail = process.env.EMAIL_USER;
    if (adminEmail) {
      await sendEmail({
        to: [adminEmail],
        subject: `Schedule finalized: ${weekLabel}`,
        html: `<p>The schedule for <strong>${weekLabel}</strong> was finalized and sent to ${emailedCount} of ${staffList.length} staff member(s) by email. Everyone with a shift that week will also see an in-app notice.</p>`,
      });
    }

    res.status(201).json({ finalization, staff_notified: staffList.length, emails_sent: emailedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to finalize schedule: ' + err.message });
  }
});

// GET /shifts/unacknowledged-finalizations — pending in-app notices for the
// logged-in staff member, same pattern as GET /schedule-events/unacknowledged.
router.get('/unacknowledged-finalizations', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sf.id, sf.week_start
       FROM schedule_finalization_recipients sfr
       JOIN schedule_finalizations sf ON sfr.finalization_id = sf.id
       WHERE sfr.staff_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM schedule_finalization_acks sfa
           WHERE sfa.finalization_id = sf.id AND sfa.staff_id = $1
         )
       ORDER BY sf.week_start ASC`,
      [req.staff.staff_id]
    );

    // Attach this staff member's own shifts for each pending week, so the
    // popup can show exactly what they're being asked to acknowledge.
    const withShifts = [];
    for (const row of result.rows) {
      const weekEnd = new Date(row.week_start);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const shiftsResult = await pool.query(
        `SELECT * FROM shifts WHERE staff_id = $1 AND shift_date >= $2 AND shift_date <= $3 ORDER BY shift_date ASC, start_time ASC`,
        [req.staff.staff_id, row.week_start, weekEnd.toISOString().slice(0, 10)]
      );
      withShifts.push({ ...row, shifts: shiftsResult.rows });
    }

    res.json(withShifts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch schedule notices' });
  }
});

// POST /shifts/finalizations/:id/acknowledge — the logged-in staff member
// dismisses one pending notice. Inserts a fresh ack row (there is no
// pre-existing row to update — see schema comments).
router.post('/finalizations/:id(\\d+)/acknowledge', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO schedule_finalization_acks (finalization_id, staff_id)
       VALUES ($1, $2)
       ON CONFLICT (finalization_id, staff_id) DO NOTHING
       RETURNING *`,
      [req.params.id, req.staff.staff_id]
    );
    res.json(result.rows[0] || { already_acknowledged: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to acknowledge' });
  }
});

module.exports = router;
