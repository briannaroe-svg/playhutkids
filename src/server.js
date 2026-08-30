require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const childrenRoutes = require('./routes/children');
const familiesRoutes = require('./routes/families');
const invoicesRoutes = require('./routes/invoices');
const feeAdjustmentsRoutes = require('./routes/feeAdjustments');
const staffRoutes = require('./routes/staff');
const timesheetsRoutes = require('./routes/timesheets');
const agreementsRoutes = require('./routes/agreements');
const authRoutes = require('./routes/auth');
const webhooksRoutes = require('./routes/webhooks');
const serviceItemsRoutes = require('./routes/serviceItems');
const attendanceRoutes = require('./routes/attendance');
const shiftsRoutes = require('./routes/shifts');
const scheduleEventsRoutes = require('./routes/scheduleEvents');
const timeOffRequestsRoutes = require('./routes/timeOffRequests');
const registrationsRoutes = require('./routes/registrations');
const staffAgreementsRoutes = require('./routes/staffAgreements');
const familyAuthRoutes = require('./routes/familyAuth');
const dailyReportsRoutes = require('./routes/dailyReports');
const messagesRoutes = require('./routes/messages');
const waitlistRoutes = require('./routes/waitlist');
const childDocumentsRoutes = require('./routes/childDocuments');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- CORS whitelist ----
// Mirrors KP's pattern: explicit origins only, update when frontend hosting is finalized
const allowedOrigins = [
  'https://www.playhutkids.com',
  'https://playhutkids.com',
  'https://little-playhut-backend.onrender.com',
  'https://playhutkids.onrender.com', // Render Static Site hosting login.html / dashboard.html
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
}));

// ---- Security headers ----
// NOTE: Helmet's default CSP blocks inline scripts on backend-served pages —
// this bit KP during agreements.js development. Adjust directives here if
// serving any HTML/canvas signing pages directly from this backend.
app.use(helmet());

// ---- Stripe webhook (raw body required) ----
// MUST be mounted before express.json() below — Stripe signature verification
// needs the raw, unparsed request body. This is the one route in the whole app
// that does NOT get JSON-parsed globally.
app.use('/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);

// ---- Body parsing (for every other route) ----
// Base64 signature images (agreements) need a larger limit than the 100kb default.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ---- Route mounts ----
// Route order matters: more specific paths before parameterized /:id routes.
app.use('/auth', authRoutes);
app.use('/children', childrenRoutes);
app.use('/families', familiesRoutes);
app.use('/invoices', invoicesRoutes);
app.use('/fee-adjustments', feeAdjustmentsRoutes);
app.use('/staff', staffRoutes);
app.use('/timesheets', timesheetsRoutes);
app.use('/agreements', agreementsRoutes);
app.use('/service-items', serviceItemsRoutes);
app.use('/attendance', attendanceRoutes);
app.use('/shifts', shiftsRoutes);
app.use('/schedule-events', scheduleEventsRoutes);
app.use('/time-off', timeOffRequestsRoutes);
app.use('/registrations', registrationsRoutes);
app.use('/staff-agreements', staffAgreementsRoutes);
app.use('/family-auth', familyAuthRoutes);
app.use('/daily-reports', dailyReportsRoutes);
app.use('/messages', messagesRoutes);
app.use('/waitlist', waitlistRoutes);
app.use('/child-documents', childDocumentsRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'Little Playhut backend is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Publishable key is safe to expose publicly — it's designed to be used
// client-side (this is how Stripe Elements/Stripe.js is meant to be
// configured). The SECRET key never leaves the backend's own env vars.
app.get('/config/stripe-key', (req, res) => {
  res.json({ publishable_key: process.env.STRIPE_PUBLISHABLE_KEY });
});

app.listen(PORT, () => {
  console.log(`Little Playhut backend listening on port ${PORT}`);
});

module.exports = app;
