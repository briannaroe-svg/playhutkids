const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { hashPassword, verifyPassword, signFamilyToken } = require('../utils/auth');
const { requireAdmin, requireFamilyAuth } = require('../middleware/auth');

// ============================================================
// PARENT PORTAL AUTHENTICATION
// ============================================================

// POST /family-auth/login — a parent logs into their own portal view
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    const result = await pool.query(
      `SELECT * FROM families WHERE primary_parent_email = $1`,
      [email]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

    const family = result.rows[0];
    if (!family.password_hash) {
      return res.status(401).json({ error: 'This account has no portal access set up yet — contact the school' });
    }

    const passwordMatches = await verifyPassword(password, family.password_hash);
    if (!passwordMatches) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signFamilyToken(family);
    res.json({
      token,
      family: {
        id: family.id,
        primary_parent_name: family.primary_parent_name,
        primary_parent_email: family.primary_parent_email,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /family-auth/:familyId/set-password — admin only, sets/resets a family's portal password
router.post('/:familyId(\\d+)/set-password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required' });

  try {
    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `UPDATE families SET password_hash = $2 WHERE id = $1
       RETURNING id, primary_parent_name, primary_parent_email`,
      [req.params.familyId, passwordHash]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Family not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set portal password' });
  }
});

// ============================================================
// PARENT-FACING: their own children's daily reports
// ============================================================

// GET /family-auth/my-children — the logged-in parent's own children (for the portal's child picker)
router.get('/my-children', requireFamilyAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, first_name, last_name, program, room
       FROM children WHERE family_id = $1 AND enrollment_status = 'active'
       ORDER BY first_name`,
      [req.family.family_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your children' });
  }
});

// GET /family-auth/reports?child_id=&start=&end=  — the logged-in parent's own children's reports only.
// child_id is verified to actually belong to this family — a parent can never
// read another family's child's report by guessing an id.
router.get('/reports', requireFamilyAuth, async (req, res) => {
  const { child_id, start, end } = req.query;
  try {
    if (child_id) {
      const ownsChild = await pool.query(
        `SELECT 1 FROM children WHERE id = $1 AND family_id = $2`,
        [child_id, req.family.family_id]
      );
      if (ownsChild.rows.length === 0) return res.status(403).json({ error: 'Not your child' });
    }

    let query = `
      SELECT dr.*, c.first_name AS child_first_name, c.last_name AS child_last_name,
        COALESCE(
          (SELECT json_agg(photo_url) FROM daily_report_photos WHERE daily_report_id = dr.id), '[]'
        ) AS photos
      FROM daily_reports dr
      JOIN children c ON dr.child_id = c.id
      WHERE c.family_id = $1`;
    const params = [req.family.family_id];
    if (child_id) { params.push(child_id); query += ` AND dr.child_id = $${params.length}`; }
    if (start) { params.push(start); query += ` AND dr.report_date >= $${params.length}`; }
    if (end) { params.push(end); query += ` AND dr.report_date <= $${params.length}`; }
    query += ` ORDER BY dr.report_date DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch daily reports' });
  }
});

// ============================================================
// PARENT-FACING: messaging with staff
// ============================================================

// GET /family-auth/messages/unread-count — how many unread staff messages the
// parent has, without marking anything read (for the tab badge on login)
router.get('/messages/unread-count', requireFamilyAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE family_id = $1 AND sender_type = 'staff' AND read_by_family = false`,
      [req.family.family_id]
    );
    res.json({ count: Number(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// GET /family-auth/messages — the logged-in parent's own thread, marks
// staff messages as read-by-family as a side effect of opening it
router.get('/messages', requireFamilyAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, s.first_name AS staff_first_name, s.last_name AS staff_last_name
       FROM messages m
       LEFT JOIN staff s ON m.sender_staff_id = s.id
       WHERE m.family_id = $1
       ORDER BY m.created_at ASC`,
      [req.family.family_id]
    );

    await pool.query(
      `UPDATE messages SET read_by_family = true WHERE family_id = $1 AND sender_type = 'staff' AND read_by_family = false`,
      [req.family.family_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /family-auth/messages — the logged-in parent sends a message to staff
router.post('/messages', requireFamilyAuth, async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });

  try {
    const result = await pool.query(
      `INSERT INTO messages (family_id, sender_type, body, read_by_family)
       VALUES ($1, 'family', $2, true)
       RETURNING *`,
      [req.family.family_id, body.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
