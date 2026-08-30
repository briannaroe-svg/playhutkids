const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// GET /service-items?active=true
router.get('/', async (req, res) => {
  const { active } = req.query;
  try {
    const query = active === 'true'
      ? `SELECT * FROM service_items WHERE is_active = true ORDER BY name`
      : `SELECT * FROM service_items ORDER BY name`;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service items' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM service_items WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Service item not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service item' });
  }
});

router.post('/', async (req, res) => {
  const { name, description, default_price } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const result = await pool.query(
      `INSERT INTO service_items (name, description, default_price)
       VALUES ($1,$2,$3) RETURNING *`,
      [name, description || null, default_price || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create service item' });
  }
});

// PUT /service-items/:id — allowlisted fields, same pattern as staff.js
router.put('/:id(\\d+)', async (req, res) => {
  const allowedFields = ['name', 'description', 'default_price', 'is_active'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  const fieldNames = Object.keys(updates);
  const setClauses = fieldNames.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = fieldNames.map((key) => updates[key]);

  try {
    const result = await pool.query(
      `UPDATE service_items SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Service item not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update service item' });
  }
});

module.exports = router;
