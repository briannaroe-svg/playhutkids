const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// Column list shared by every read route below — explicitly excludes
// password_hash (the parent portal login secret) and instead exposes a
// derived boolean, has_portal_access, so the admin UI can show portal status
// without ever receiving the hash itself.
const FAMILY_COLUMNS = `
  id, primary_parent_name, primary_parent_email, primary_parent_phone,
  secondary_parent_name, secondary_parent_email, secondary_parent_phone,
  mailing_address, stripe_customer_id, created_at, updated_at,
  (password_hash IS NOT NULL) AS has_portal_access
`;

router.get('/search', async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      `SELECT ${FAMILY_COLUMNS} FROM families WHERE primary_parent_name ILIKE $1 OR primary_parent_email ILIKE $1`,
      [`%${q || ''}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search families' });
  }
});

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`SELECT ${FAMILY_COLUMNS} FROM families ORDER BY primary_parent_name`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch families' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const family = await pool.query(`SELECT ${FAMILY_COLUMNS} FROM families WHERE id = $1`, [req.params.id]);
    if (family.rows.length === 0) return res.status(404).json({ error: 'Family not found' });
    const children = await pool.query(`SELECT * FROM children WHERE family_id = $1`, [req.params.id]);
    res.json({ ...family.rows[0], children: children.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch family' });
  }
});

router.post('/', async (req, res) => {
  const {
    primary_parent_name, primary_parent_email, primary_parent_phone,
    secondary_parent_name, secondary_parent_email, secondary_parent_phone,
    mailing_address,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO families
        (primary_parent_name, primary_parent_email, primary_parent_phone,
         secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [primary_parent_name, primary_parent_email, primary_parent_phone,
       secondary_parent_name, secondary_parent_email, secondary_parent_phone, mailing_address]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create family' });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  const fields = req.body;
  const setClauses = Object.keys(fields).map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = Object.values(fields);

  try {
    const result = await pool.query(
      `UPDATE families SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Family not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update family' });
  }
});

module.exports = router;
