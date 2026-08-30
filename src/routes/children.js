const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// GET /children/my-assigned — staff's own roster (must come before /:id).
// Any authenticated staff member sees the children assigned to them; admins
// calling this see nothing special (they should use GET / for the full roster).
router.get('/my-assigned', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.* FROM children c
       JOIN child_staff_assignments csa ON csa.child_id = c.id
       WHERE csa.staff_id = $1 AND c.enrollment_status = 'active'
       ORDER BY c.last_name, c.first_name`,
      [req.staff.staff_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch assigned children' });
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

// GET /children  — full roster, optional ?status=active — admin only
router.get('/', requireAdmin, async (req, res) => {
  const { status } = req.query;
  try {
    const query = status
      ? `SELECT c.*,
           COALESCE(
             (SELECT json_agg(json_build_object('id', s.id, 'first_name', s.first_name, 'last_name', s.last_name))
              FROM child_staff_assignments csa JOIN staff s ON csa.staff_id = s.id
              WHERE csa.child_id = c.id), '[]'
           ) AS assigned_staff
         FROM children c WHERE c.enrollment_status = $1 ORDER BY c.last_name`
      : `SELECT c.*,
           COALESCE(
             (SELECT json_agg(json_build_object('id', s.id, 'first_name', s.first_name, 'last_name', s.last_name))
              FROM child_staff_assignments csa JOIN staff s ON csa.staff_id = s.id
              WHERE csa.child_id = c.id), '[]'
           ) AS assigned_staff
         FROM children c ORDER BY c.last_name`;
    const params = status ? [status] : [];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch children' });
  }
});

// GET /children/:id  — numeric guard so it doesn't shadow other routes.
// Admin: any child. Staff: only if assigned to them.
router.get('/:id(\\d+)', requireAuth, async (req, res) => {
  try {
    if (req.staff.access_level !== 'admin') {
      const assigned = await pool.query(
        `SELECT 1 FROM child_staff_assignments WHERE child_id = $1 AND staff_id = $2`,
        [req.params.id, req.staff.staff_id]
      );
      if (assigned.rows.length === 0) return res.status(403).json({ error: 'This child is not assigned to you' });
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
    family_id, first_name, last_name, date_of_birth, program,
    enrollment_date, allergies, medical_notes,
    emergency_contact_name, emergency_contact_phone, base_tuition_rate,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO children
        (family_id, first_name, last_name, date_of_birth, program, enrollment_date,
         allergies, medical_notes, emergency_contact_name, emergency_contact_phone, base_tuition_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [family_id, first_name, last_name, date_of_birth, program, enrollment_date,
       allergies, medical_notes, emergency_contact_name, emergency_contact_phone, base_tuition_rate]
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
router.put('/:id(\\d+)/withdraw', requireAdmin, async (req, res) => {
  const { withdrawal_date } = req.body;
  try {
    const result = await pool.query(
      `UPDATE children SET enrollment_status = 'withdrawn', withdrawal_date = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, withdrawal_date || new Date().toISOString().slice(0, 10)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to withdraw child' });
  }
});

// ---- Staff assignments (admin only) ----

// POST /children/:id/assign-staff — assign a staff member to this child
router.post('/:id(\\d+)/assign-staff', requireAdmin, async (req, res) => {
  const { staff_id } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO child_staff_assignments (child_id, staff_id) VALUES ($1,$2)
       ON CONFLICT (child_id, staff_id) DO NOTHING RETURNING *`,
      [req.params.id, staff_id]
    );
    res.status(201).json(result.rows[0] || { child_id: Number(req.params.id), staff_id, already_assigned: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to assign staff' });
  }
});

// DELETE /children/:id/assign-staff/:staffId — remove an assignment
router.delete('/:id(\\d+)/assign-staff/:staffId(\\d+)', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM child_staff_assignments WHERE child_id = $1 AND staff_id = $2`,
      [req.params.id, req.params.staffId]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove staff assignment' });
  }
});

module.exports = router;
