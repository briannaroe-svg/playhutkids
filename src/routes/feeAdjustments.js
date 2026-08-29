const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// GET /fee-adjustments?child_id=...
router.get('/', async (req, res) => {
  const { child_id } = req.query;
  try {
    const query = child_id
      ? `SELECT * FROM fee_adjustments WHERE child_id = $1 ORDER BY effective_date DESC`
      : `SELECT * FROM fee_adjustments ORDER BY effective_date DESC`;
    const params = child_id ? [child_id] : [];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch fee adjustments' });
  }
});

// POST /fee-adjustments — apply a discount, credit, sibling rate, late fee, etc.
router.post('/', async (req, res) => {
  const { child_id, adjustment_type, amount, reason, is_recurring, effective_date, end_date, created_by } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO fee_adjustments
        (child_id, adjustment_type, amount, reason, is_recurring, effective_date, end_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [child_id, adjustment_type, amount, reason, is_recurring || false, effective_date || new Date().toISOString().slice(0, 10), end_date, created_by]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create fee adjustment' });
  }
});

// DELETE /fee-adjustments/:id — end/remove an adjustment
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    await pool.query(`DELETE FROM fee_adjustments WHERE id = $1`, [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove fee adjustment' });
  }
});

module.exports = router;
