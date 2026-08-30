// Email sending helper, built on nodemailer.
// Requires EMAIL_USER and EMAIL_PASS env vars (set in Render's dashboard).
// If using Gmail: EMAIL_USER is the full address, EMAIL_PASS must be an
// App Password (not the regular account password) — Gmail blocks plain
// password SMTP auth for security. Generate one at myaccount.google.com/apppasswords.
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('EMAIL_USER/EMAIL_PASS not set — email sending is disabled.');
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail', // change this if not using Gmail
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  return transporter;
}

/**
 * @param {object} params
 * @param {string[]} params.to - recipient email addresses
 * @param {string} params.subject
 * @param {string} params.html
 * @param {Array} [params.attachments] - nodemailer attachment objects, e.g.
 *   [{ filename: 'invoice.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
 * @returns {Promise<boolean>} true if actually sent, false if skipped or failed —
 *   callers that need to know whether the send succeeded (e.g. to show the
 *   admin an error) should check this; callers that intentionally don't care
 *   (existing notification emails) can ignore the return value, same as before.
 */
async function sendEmail({ to, subject, html, attachments }) {
  const t = getTransporter();
  if (!t || to.length === 0) return false; // fail silently — don't break the calling request over email issues

  try {
    await t.sendMail({
      from: `"Little Playhut" <${process.env.EMAIL_USER}>`,
      to: to.join(', '),
      subject,
      html,
      attachments,
    });
    return true;
  } catch (err) {
    // Email failures should never break the underlying feature (e.g. a time-off
    // request should still save even if the notification email fails to send).
    console.error('Failed to send email:', err);
    return false;
  }
}

module.exports = { sendEmail };
