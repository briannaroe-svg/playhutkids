const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

// GET /messages — list every family's thread with its last message and unread
// count, for a staff inbox view. Any staff member can see every family's
// thread — messaging isn't scoped by room/assignment the same way children are.
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.id AS family_id, f.primary_parent_name, f.primary_parent_email,
         (SELECT body FROM messages WHERE family_id = f.id ORDER BY created_at DESC LIMIT 1) AS last_message,
         (SELECT created_at FROM messages WHERE family_id = f.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
         (SELECT COUNT(*) FROM messages WHERE family_id = f.id AND sender_type = 'family' AND read_by_staff = false) AS unread_count
       FROM families f
       WHERE EXISTS (SELECT 1 FROM messages WHERE family_id = f.id)
       ORDER BY last_message_at DESC NULLS LAST`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// GET /messages/unread-count — total unread-from-families count, for a sidebar badge
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE sender_type = 'family' AND read_by_staff = false`
    );
    res.json({ count: Number(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// GET /messages/:familyId — full thread with one family, and marks the
// family's messages as read by staff as a side effect of opening it
router.get('/:familyId(\\d+)', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, s.first_name AS staff_first_name, s.last_name AS staff_last_name
       FROM messages m
       LEFT JOIN staff s ON m.sender_staff_id = s.id
       WHERE m.family_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.familyId]
    );

    await pool.query(
      `UPDATE messages SET read_by_staff = true WHERE family_id = $1 AND sender_type = 'family' AND read_by_staff = false`,
      [req.params.familyId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// POST /messages/:familyId — any staff member sends a message to a family
router.post('/:familyId(\\d+)', requireAuth, async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });

  try {
    const familyCheck = await pool.query(`SELECT id FROM families WHERE id = $1`, [req.params.familyId]);
    if (familyCheck.rows.length === 0) return res.status(404).json({ error: 'Family not found' });

    const result = await pool.query(
      `INSERT INTO messages (family_id, sender_type, sender_staff_id, body, read_by_staff)
       VALUES ($1, 'staff', $2, $3, true)
       RETURNING *`,
      [req.params.familyId, req.staff.staff_id, body.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
