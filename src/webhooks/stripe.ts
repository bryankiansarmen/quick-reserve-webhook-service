import { Router } from 'express';
import Stripe from 'stripe';

import { getStripe } from '../lib/stripe';
import { getSupabase } from '../lib/supabase';
import { log } from '../lib/log';
import type { RawBodyRequest } from '../types';
import { handlePaymentIntentSucceeded } from './handlers/paymentIntentSucceeded';
import { handlePaymentIntentFailed } from './handlers/paymentIntentFailed';

const router = Router();

// `POST /webhooks/stripe` — Stripe-initiated only.
// Every failure returns non-2xx so Stripe retries; idempotency is handled by
// checking current booking status before re-applying state (see handler).
router.post('/stripe', async (req, res) => {
  const rawBody = (req as RawBodyRequest).rawBody;
  const signature = req.header('stripe-signature');

  if (!rawBody || !signature) {
    log('warn', 'webhook.missing_signature', {
      hasRawBody: Boolean(rawBody),
      hasSignature: Boolean(signature),
    });
    res.status(400).json({
      error: { code: 'INVALID_SIGNATURE', message: 'Missing Stripe-Signature header' },
    });
    return;
  }

  const stripe = getStripe();
  if (!stripe) {
    log('error', 'webhook.stripe_unconfigured', {});
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Stripe is not configured' },
    });
    return;
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    log('error', 'webhook.secret_missing', {});
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Webhook secret is not configured' },
    });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log('warn', 'webhook.invalid_signature', { message });
    res.status(400).json({
      error: { code: 'INVALID_SIGNATURE', message: 'Invalid Stripe signature' },
    });
    return;
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const supabase = getSupabase();
        if (!supabase) {
          log('error', 'webhook.supabase_unconfigured', {});
          res.status(500).json({
            error: { code: 'INTERNAL_ERROR', message: 'Database is not configured' },
          });
          return;
        }
        await handlePaymentIntentSucceeded(event, supabase);
        break;
      }
      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event);
        break;
      default:
        log('info', 'webhook.unhandled', { type: event.type, id: event.id });
        break;
    }

    res.json({ received: true, type: event.type });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log('error', 'webhook.processing_failed', { type: event.type, id: event.id, message });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Webhook processing failed' },
    });
  }
});

export { router as stripeRouter };
