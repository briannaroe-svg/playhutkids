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
 */
async function sendEmail({ to, subject, html }) {
  const t = getTransporter();
  if (!t || to.length === 0) return; // fail silently — don't break the calling request over email issues

  try {
    await t.sendMail({
      from: `"Little Playhut" <${process.env.EMAIL_USER}>`,
      to: to.join(', '),
      subject,
      html,
    });
  } catch (err) {
    // Email failures should never break the underlying feature (e.g. a time-off
    // request should still save even if the notification email fails to send).
    console.error('Failed to send email:', err);
  }
}

module.exports = { sendEmail };
