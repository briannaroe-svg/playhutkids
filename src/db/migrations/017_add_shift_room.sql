-- Migration: add room assignment to shifts, for the weekly room-schedule grid
-- (mirrors the paper "Weekly Employee Schedule" form, organized by room
-- instead of by staff member). Nullable — a shift can still exist with no
-- room noted, same flexibility as before this migration.
-- Run against the same Neon database, same way as prior migrations —
-- paste into Neon's SQL Editor and run.

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS room VARCHAR(50);

ALTER TABLE shifts ADD CONSTRAINT shifts_room_check CHECK (
  room IS NULL OR room IN (
    'Little Bunnies',
    'Little Raccoons',
    'Little Cubs',
    '3 Year Old Preschool-AM',
    '3 Year Old Preschool-PM',
    '4 Year Old Preschool-AM',
    '4 Year Old Preschool-PM',
    'Wolf Den'
  )
);

CREATE INDEX IF NOT EXISTS idx_shifts_room ON shifts(room);
