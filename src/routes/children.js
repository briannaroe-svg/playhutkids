const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const VALID_ROOMS = [
  'Little Bunnies',
  'Little Raccoons',
  'Little Cubs',
  '3 Year Old Preschool-AM',
  '3 Year Old Preschool-PM',
  '4 Year Old Preschool-AM',
  '4 Year Old Preschool-PM',
  'Wolf Den',
];

// GET /children/rooms — the fixed list of room options, for populating a dropdown
router.get('/rooms', requireAuth, async (req, res) => {
  res.json(VALID_ROOMS);
});

// GET /children/upcoming-birthdays?days=14 — active children whose birthday
// (month/day, regardless of birth year) falls within the next N days, for
// the Home page. The "next occurrence" math is done here in JS rather than
// in SQL — computing "swap in this year, or next year if it already passed"
// entirely in Postgres date arithmetic gets fragile fast (leap-year Feb 29
// birthdays, year-end wraparound), and this table is never large enough for
// doing it in JS to be a real performance concern.
router.get('/upcoming-birthdays', requireAuth, async (req, res) => {
  const days = Math.min(Number(req.query.days) || 14, 60); // capped — a "heads up" list, not a full calendar
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, date_of_birth, room
       FROM children WHERE enrollment_status = 'active'`
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowEnd = new Date(today);
    windowEnd.setDate(windowEnd.getDate() + days);

    const upcoming = result.rows
      .map((child) => {
        const dob = new Date(child.date_of_birth);
        const birthMonth = dob.getUTCMonth();
        const birthDay = dob.getUTCDate();

        // This year's occurrence, safely handling Feb 29 in a non-leap year
        // by clamping to the last real day of that month (Feb 28).
        const daysInThisYearsBirthMonth = new Date(today.getFullYear(), birthMonth + 1, 0).getDate();
        let occurrence = new Date(today.getFullYear(), birthMonth, Math.min(birthDay, daysInThisYearsBirthMonth));
        if (occurrence < today) {
          const daysInNextYearsBirthMonth = new Date(today.getFullYear() + 1, birthMonth + 1, 0).getDate();
          occurrence = new Date(today.getFullYear() + 1, birthMonth, Math.min(birthDay, daysInNextYearsBirthMonth));
        }

        return {
          ...child,
          next_occurrence: occurrence.toISOString().slice(0, 10),
          turning_age: occurrence.getFullYear() - dob.getUTCFullYear(),
          _sortDate: occurrence,
        };
      })
      .filter((c) => c._sortDate >= today && c._sortDate <= windowEnd)
      .sort((a, b) => a._sortDate - b._sortDate)
      .map(({ _sortDate, ...rest }) => rest); // drop the internal sort helper before responding

    res.json(upcoming);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch upcoming birthdays' });
  }
});

// GET /children/search?q=...  (must come before /:id so it isn't shadowed) — admin only
router.get('/search', requireAdmin, async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM children WHERE first_name ILIKE $1 OR last_name ILIKE $1 ORDER BY last_name`,
      [`%${q || ''}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search children' });
  }
});

// GET /children  — full roster, optional ?status=active. Any authenticated staff
// member can see the roster (children are grouped by room now, not assigned to
// individual staff — everyone floats until room-based staff assignment exists).
// Admin gets the full record including family_id; staff gets everything except
// parent/family contact fields, matching the same exclusion GET /:id already did.
router.get('/', requireAuth, async (req, res) => {
  const { status } = req.query;
  const isAdmin = req.staff.access_level === 'admin';
  try {
    const columns = isAdmin
      ? 'c.*'
      : `c.id, c.first_name, c.last_name, c.date_of_birth, c.program, c.room, c.enrollment_status,
         c.allergies, c.medical_notes, c.emergency_contact_name, c.emergency_contact_phone,
         c.potty_trained, c.sunscreen_outdoor_play_consent, c.field_trip_consent,
         c.bathroom_assistance_consent, c.immunization_status, c.child_interests_personality,
         c.daycare_enrollment_option, c.daycare_schedule_days, c.daycare_attendance_type,
         c.daycare_dropoff_time, c.daycare_pickup_time, c.preschool_addon_schedule,
         c.infant_feeding_plan, c.infant_care_authorization_consent`;
    const query = status
      ? `SELECT ${columns} FROM children c WHERE c.enrollment_status = $1 ORDER BY c.room, c.last_name`
      : `SELECT ${columns} FROM children c ORDER BY c.room, c.last_name`;
    const params = status ? [status] : [];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch children' });
  }
});

// GET /children/:id  — numeric guard so it doesn't shadow other routes.
// Admin: full record including family contact info. Staff: everything except
// family/parent contact fields — excluded from the query itself, not just
// hidden client-side, so that data never leaves the server for a non-admin request.
router.get('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    if (req.staff.access_level !== 'admin') {
      const result = await pool.query(
        `SELECT id, first_name, last_name, date_of_birth, program, room, enrollment_status,
                allergies, medical_notes, emergency_contact_name, emergency_contact_phone
         FROM children WHERE id = $1`,
        [req.params.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Child not found' });
      return res.json(result.rows[0]);
    }

    const result = await pool.query(`SELECT * FROM children WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Child not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch child' });
  }
});

// POST /children  — new registration — admin only
router.post('/', requireAdmin, async (req, res) => {
  const {
    family_id, first_name, last_name, date_of_birth, program, room,
    enrollment_date, allergies, medical_notes,
    emergency_contact_name, emergency_contact_phone, base_tuition_rate,
    potty_trained, sunscreen_outdoor_play_consent, field_trip_consent,
    bathroom_assistance_consent, immunization_status, child_interests_personality,
  } = req.body;

  if (room && !VALID_ROOMS.includes(room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO children
        (family_id, first_name, last_name, date_of_birth, program, room, enrollment_date,
         allergies, medical_notes, emergency_contact_name, emergency_contact_phone, base_tuition_rate,
         potty_trained, sunscreen_outdoor_play_consent, field_trip_consent,
         bathroom_assistance_consent, immunization_status, child_interests_personality)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [family_id, first_name, last_name, date_of_birth, program, room || null, enrollment_date,
       allergies, medical_notes, emergency_contact_name, emergency_contact_phone, base_tuition_rate,
       potty_trained ?? null, sunscreen_outdoor_play_consent ?? null, field_trip_consent ?? null,
       bathroom_assistance_consent ?? null, immunization_status || null, child_interests_personality || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register child' });
  }
});

// PUT /children/:id  — update record — admin only
router.put('/:id(\\d+)', requireAdmin, async (req, res) => {
  const fields = req.body;

  if (fields.room !== undefined && fields.room !== null && !VALID_ROOMS.includes(fields.room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }

  const setClauses = Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = Object.values(fields);

  try {
    const result = await pool.query(
      `UPDATE children SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Child not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update child' });
  }
});

// PUT /children/:id/withdraw — admin only
// PUT /children/:id/withdraw — marks one child withdrawn. If this was the
// family's ONLY remaining active child, also pauses every active recurring
// plan for that family AND marks the family itself is_unenrolled — see
// families.js's own /unenroll route for why that flag exists as a direct,
// independent field rather than something derived purely from children.
router.put('/:id(\\d+)/withdraw', requireAdmin, async (req, res) => {
  const { withdrawal_date } = req.body;
  try {
    const childResult = await pool.query(`SELECT * FROM children WHERE id = $1`, [req.params.id]);
    if (childResult.rows.length === 0) return res.status(404).json({ error: 'Child not found' });
    const familyId = childResult.rows[0].family_id;

    const result = await pool.query(
      `UPDATE children SET enrollment_status = 'withdrawn', withdrawal_date = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, withdrawal_date || new Date().toISOString().slice(0, 10)]
    );

    const remainingActive = await pool.query(
      `SELECT COUNT(*) FROM children WHERE family_id = $1 AND enrollment_status = 'active'`,
      [familyId]
    );
    let plansPaused = 0;
    if (Number(remainingActive.rows[0].count) === 0) {
      const paused = await pool.query(
        `UPDATE recurring_plans SET is_active = false, updated_at = now()
         WHERE family_id = $1 AND is_active = true RETURNING id`,
        [familyId]
      );
      plansPaused = paused.rows.length;
      await pool.query(
        `UPDATE families SET is_unenrolled = true, unenrolled_at = now(), updated_at = now() WHERE id = $1`,
        [familyId]
      );
    }

    res.json({ ...result.rows[0], recurring_plans_paused: plansPaused });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to withdraw child' });
  }
});

// GET /children/duplicates — admin only. Flags pairs of child records that
// look like the same real kid: same first + last name (case/whitespace
// insensitive) AND same date of birth — both signals together, since name
// alone would false-positive on two different children who happen to share
// a common name. Never merges or deletes anything itself.
router.get('/duplicates', requireAdmin, async (req, res) => {
  try {
    const allChildren = await pool.query(
      `SELECT c.*, f.primary_parent_name, f.primary_parent_email
       FROM children c JOIN families f ON c.family_id = f.id
       ORDER BY c.created_at ASC`
    );
    const children = allChildren.rows;

    const normalize = (s) => (s || '').trim().toLowerCase();
    const pairs = [];

    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const a = children[i], b = children[j];
        const sameName = normalize(a.first_name) === normalize(b.first_name) && normalize(a.last_name) === normalize(b.last_name);
        const sameDob = a.date_of_birth && b.date_of_birth &&
          new Date(a.date_of_birth).getTime() === new Date(b.date_of_birth).getTime();
        if (sameName && sameDob) {
          pairs.push({ child_a: a, child_b: b });
        }
      }
    }

    res.json(pairs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to find duplicate children' });
  }
});

// POST /children/merge — admin only. Merges TWO child records into one:
// every fee adjustment, invoice line item, staff assignment, attendance
// record, agreement, daily report, and document from `duplicate_id` is
// re-pointed to `keep_id`, then the now-empty duplicate is deleted. The
// keeper's own family_id never changes — merging never moves a child
// between families, only combines two records for what is judged to be the
// same real child. All in one transaction: either the whole merge succeeds,
// or none of it does.
router.post('/merge', requireAdmin, async (req, res) => {
  const { keep_id, duplicate_id } = req.body;
  if (!keep_id || !duplicate_id) {
    return res.status(400).json({ error: 'keep_id and duplicate_id are required' });
  }
  if (keep_id === duplicate_id) {
    return res.status(400).json({ error: 'keep_id and duplicate_id must be different children' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const keepResult = await client.query(`SELECT * FROM children WHERE id = $1 FOR UPDATE`, [keep_id]);
    const dupResult = await client.query(`SELECT * FROM children WHERE id = $1 FOR UPDATE`, [duplicate_id]);
    if (keepResult.rows.length === 0 || dupResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'One or both children were not found' });
    }

    // child_staff_assignments has a UNIQUE(child_id, staff_id) constraint —
    // if both the keeper and the duplicate are already assigned to the same
    // staff member, blindly re-pointing the duplicate's row would violate
    // that constraint. Delete any of the duplicate's assignment rows that
    // would collide, then re-point whatever's left.
    await client.query(
      `DELETE FROM child_staff_assignments dup_csa
       WHERE dup_csa.child_id = $2
         AND EXISTS (
           SELECT 1 FROM child_staff_assignments keep_csa
           WHERE keep_csa.child_id = $1 AND keep_csa.staff_id = dup_csa.staff_id
         )`,
      [keep_id, duplicate_id]
    );
    await client.query(`UPDATE child_staff_assignments SET child_id = $1 WHERE child_id = $2`, [keep_id, duplicate_id]);

    await client.query(`UPDATE fee_adjustments SET child_id = $1 WHERE child_id = $2`, [keep_id, duplicate_id]);
    await client.query(`UPDATE invoice_line_items SET child_id = $1 WHERE child_id = $2`, [keep_id, duplicate_id]);
    await client.query(`UPDATE attendance_records SET child_id = $1 WHERE child_id = $2`, [keep_id, duplicate_id]);
    await client.query(`UPDATE agreements SET child_id = $1 WHERE child_id = $2`, [keep_id, duplicate_id]);
    await client.query(`UPDATE daily_reports SET child_id = $1 WHERE child_id = $2`, [keep_id, duplicate_id]);
    await client.query(`UPDATE child_documents SET child_id = $1 WHERE child_id = $2`, [keep_id, duplicate_id]);
    await client.query(`UPDATE registrations SET resulting_child_id = $1 WHERE resulting_child_id = $2`, [keep_id, duplicate_id]);

    await client.query(`DELETE FROM children WHERE id = $1`, [duplicate_id]);

    const finalResult = await client.query(`SELECT * FROM children WHERE id = $1`, [keep_id]);
    await client.query('COMMIT');

    res.json({ merged_child: finalResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to merge children: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
