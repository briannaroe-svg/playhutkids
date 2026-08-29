-- Migration: add authentication fields to staff
-- Run this against the same Neon database as schema.sql, after the initial schema.
-- (Neon SQL Editor: paste and run, same as the original schema.)

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255),
  ADD COLUMN IF NOT EXISTS access_level VARCHAR(20) NOT NULL DEFAULT 'staff';
  -- access_level: 'staff' | 'admin'

-- Existing staff rows (if any) default to 'staff' access and have no password set
-- until they're given one via the bootstrap/admin flow.
