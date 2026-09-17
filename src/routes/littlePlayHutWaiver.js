// routes/littlePlayHutWaiver.js
//
// A SELF-CONTAINED route for "The Little Play Hut" (the sibling
// play-space/party-venue business) waiver submissions. Deliberately kept
// separate from every other route in this server: no shared tables, no
// shared imports beyond Express/nodemailer, and no access to the daycare
// app's database at all — this route never touches `pool` or any of the
// families/children/invoices tables. It exists purely to receive one
// finished, signed waiver PDF (already generated in the browser) and email
// it to the business.
//
// Mount this in server.js with:
//   const littlePlayHutWaiverRoutes = require('./routes/littlePlayHutWaiver');
//   app.use('/little-play-hut-waiver', littlePlayHutWaiverRoutes);
//
// Requires the same EMAIL_USER / EMAIL_PASS environment variables already
// set on this Render service for the daycare app's own emails (a Gmail
// address + an App Password, not the normal account password). No new
// environment variables needed if those are already set; if this waiver
// should send FROM a different address than the daycare app uses, set
// WAIVER_EMAIL_USER / WAIVER_EMAIL_PASS instead and this file will prefer
// those automatically.

const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

const RECIPIENT_EMAIL = 'theplayhutid@gmail.com';
const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8 MB — generous for a text+signature PDF, guards against an oversized payload

function getTransporter() {
  const user = process.env.WAIVER_EMAIL_USER || process.env.EMAIL_USER;
  const pass = process.env.WAIVER_EMAIL_PASS || process.env.EMAIL_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

// POST /little-play-hut-waiver/submit
// Body: { pdf_base64: string (no data: prefix), adult_name: string, adult_email: string, minor_names: string[] }
// The PDF itself is generated client-side (in waiver.html) — this route
// only relays it by email, it never stores or inspects the waiver content.
router.post('/submit', express.json({ limit: '12mb' }), async (req, res) => {
  const { pdf_base64, adult_name, adult_email, minor_names } = req.body;

  if (!pdf_base64 || !adult_name || !adult_email) {
    return res.status(400).json({ error: 'pdf_base64, adult_name, and adult_email are required' });
  }

  let pdfBuffer;
  try {
    pdfBuffer = Buffer.from(pdf_base64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'pdf_base64 was not valid base64 data' });
  }
  if (pdfBuffer.length === 0 || pdfBuffer.length > MAX_PDF_BYTES) {
    return res.status(400).json({ error: 'The signed waiver PDF was empty or too large' });
  }

  const transporter = getTransporter();
  if (!transporter) {
    console.error('Little Play Hut waiver: EMAIL_USER/EMAIL_PASS not configured on this server');
    return res.status(500).json({ error: 'Email is not configured on the server yet — please contact the business directly for now.' });
  }

  const minorList = Array.isArray(minor_names) && minor_names.length > 0
    ? minor_names.join(', ')
    : '(none listed)';
  const safeFileNamePart = adult_name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'waiver';

  try {
    await transporter.sendMail({
      from: `"The Little Play Hut — Waivers" <${process.env.WAIVER_EMAIL_USER || process.env.EMAIL_USER}>`,
      to: RECIPIENT_EMAIL,
      replyTo: adult_email,
      subject: `Signed waiver — ${adult_name}`,
      text: `A new waiver was signed and submitted.\n\nSigner: ${adult_name} (${adult_email})\nMinor(s): ${minorList}\n\nThe signed, completed waiver is attached as a PDF.`,
      attachments: [
        {
          filename: `LittlePlayHut-Waiver-${safeFileNamePart}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to send Little Play Hut waiver email:', err);
    res.status(500).json({ error: 'Failed to send the waiver email — please try again, or contact the business directly.' });
  }
});

module.exports = router;
