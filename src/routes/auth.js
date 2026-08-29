const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { hashPassword, verifyPassword, signToken } = require('../utils/auth');

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    const result = await pool.query(
      `SELECT * FROM staff WHERE email = $1 AND is_active = true`,
      [email]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

    const staffMember = result.rows[0];
    if (!staffMember.password_hash) {
      return res.status(401).json({ error: 'This account has no password set yet — contact an admin' });
    }

    const passwordMatches = await verifyPassword(password, staffMember.password_hash);
    if (!passwordMatches) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(staffMember);
    res.json({
      token,
      staff: {
        id: staffMember.id,
        first_name: staffMember.first_name,
        last_name: staffMember.last_name,
        email: staffMember.email,
        access_level: staffMember.access_level,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/bootstrap-admin — creates the FIRST admin account.
// Guarded by BOOTSTRAP_SECRET (set in Render env vars) rather than requiring
// an existing login, since there's no way to log in before any admin exists.
// Only works if there are currently zero admin accounts — once one exists,
// this route refuses to create another, so it can't be reused as a backdoor.
router.post('/bootstrap-admin', async (req, res) => {
  const { secret, first_name, last_name, email, password } = req.body;

  if (!process.env.BOOTSTRAP_SECRET || secret !== process.env.BOOTSTRAP_SECRET) {
    return res.status(403).json({ error: 'Invalid bootstrap secret' });
  }

  try {
    const existingAdmins = await pool.query(`SELECT id FROM staff WHERE access_level = 'admin' LIMIT 1`);
    if (existingAdmins.rows.length > 0) {
      return res.status(400).json({ error: 'An admin account already exists — bootstrap is disabled' });
    }

    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `INSERT INTO staff (first_name, last_name, email, password_hash, access_level, is_active)
       VALUES ($1,$2,$3,$4,'admin',true)
       RETURNING id, first_name, last_name, email, access_level`,
      [first_name, last_name, email, passwordHash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create admin account' });
  }
});

module.exports = router;
