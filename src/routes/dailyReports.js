const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { uploadBase64Image } = require('../utils/cloudinary');

// GET /daily-reports?child_id=&date=  — staff view of a report (any staff can view/fill any child's report,
// same as the rest of Children — everyone floats across rooms for now)
router.get('/', requireAuth, async (req, res) => {
  const { child_id, date } = req.query;
  if (!child_id || !date) return res.status(400).json({ error: 'child_id and date are required' });

  try {
    const result = await pool.query(
      `SELECT dr.*,
         COALESCE(
           (SELECT json_agg(photo_url) FROM daily_report_photos WHERE daily_report_id = dr.id), '[]'
         ) AS photos
       FROM daily_reports dr
       WHERE dr.child_id = $1 AND dr.report_date = $2`,
      [child_id, date]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch daily report' });
  }
});

// POST /daily-reports — create or update today's (or any date's) report for a child.
// One report per child per day — if one already exists for that date, this updates it
// in place rather than creating a duplicate (staff filling out the form again later
// in the day, adding a nap time after lunch was already logged, etc.)
router.post('/', requireAuth, async (req, res) => {
  const { child_id, report_date, meals, nap_start, nap_end, mood, notes } = req.body;
  if (!child_id || !report_date) return res.status(400).json({ error: 'child_id and report_date are required' });

  try {
    const result = await pool.query(
      `INSERT INTO daily_reports (child_id, report_date, meals, nap_start, nap_end, mood, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (child_id, report_date) DO UPDATE SET
         meals = COALESCE(EXCLUDED.meals, daily_reports.meals),
         nap_start = COALESCE(EXCLUDED.nap_start, daily_reports.nap_start),
         nap_end = COALESCE(EXCLUDED.nap_end, daily_reports.nap_end),
         mood = COALESCE(EXCLUDED.mood, daily_reports.mood),
         notes = COALESCE(EXCLUDED.notes, daily_reports.notes),
         updated_at = now()
       RETURNING *`,
      [child_id, report_date, meals ? JSON.stringify(meals) : null, nap_start || null, nap_end || null, mood || null, notes || null, req.staff.staff_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save daily report' });
  }
});

// POST /daily-reports/:id/photos — upload a photo (base64) to an existing report
router.post('/:id(\\d+)/photos', requireAuth, async (req, res) => {
  const { photo_data } = req.body; // base64 data URI, e.g. "data:image/jpeg;base64,...."
  if (!photo_data) return res.status(400).json({ error: 'photo_data is required' });

  try {
    const reportCheck = await pool.query(`SELECT id FROM daily_reports WHERE id = $1`, [req.params.id]);
    if (reportCheck.rows.length === 0) return res.status(404).json({ error: 'Report not found' });

    const photoUrl = await uploadBase64Image(
      photo_data,
      `daily-report-${req.params.id}-${Date.now()}`,
      'little-playhut/daily-report-photos'
    );

    const result = await pool.query(
      `INSERT INTO daily_report_photos (daily_report_id, photo_url) VALUES ($1,$2) RETURNING *`,
      [req.params.id, photoUrl]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

// DELETE /daily-reports/photos/:photoId — remove a single photo from a report
router.delete('/photos/:photoId(\\d+)', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM daily_report_photos WHERE id = $1 RETURNING id`, [req.params.photoId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

module.exports = router;
