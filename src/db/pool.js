// Shared Postgres connection pool.
// DATABASE_URL comes from Neon (or Render Postgres) — set as an env var, never hardcoded.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Neon
});

module.exports = pool;
