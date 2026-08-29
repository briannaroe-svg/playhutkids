const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// POST /webhooks/stripe
// IMPORTANT: this route requires the RAW request body (not JSON-parsed) to verify
// Stripe's signature. It's mounted in server.js with express.raw() applied ONLY
// to this path, and BEFORE the global express.json() middleware — see server.js
// comments. If you ever see "No signatures found matching the expected signature"
// errors, the most likely cause is the raw-body middleware ordering got broken.
router.post('/stripe', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'payment_intent.succeeded': {
        // Payment Links (used in invoices.js) create a PaymentIntent whose metadata
        // carries invoice_id — set when the Payment Link was created.
        const obj = event.data.object;
        const invoiceId = obj.metadata?.invoice_id;

        if (invoiceId) {
          await pool.query(
            `UPDATE invoices
             SET status = 'paid', payment_method = 'card', paid_at = now(), updated_at = now(),
                 stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id)
             WHERE id = $1 AND status != 'paid'`,
            [invoiceId, obj.id || null]
          );
          console.log(`Invoice ${invoiceId} marked paid via Stripe webhook (${event.type})`);
        } else {
          console.warn(`Stripe event ${event.type} had no invoice_id in metadata — skipped`);
        }
        break;
      }

      // Add more event types here as needed (e.g. charge.refunded to reverse status)
      default:
        // Unhandled event types are fine to ignore — Stripe sends many we don't act on.
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Error processing Stripe webhook:', err);
    // Still return 200 if signature was valid but our own processing failed,
    // so Stripe doesn't retry indefinitely for a bug on our side — log it and
    // fix manually instead. Adjust to 500 only if you want Stripe's automatic retries.
    res.status(200).json({ received: true, warning: 'Processing error logged server-side' });
  }
});

module.exports = router;
