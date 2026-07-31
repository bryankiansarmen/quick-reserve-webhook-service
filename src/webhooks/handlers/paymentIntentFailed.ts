import type Stripe from 'stripe';

import { log } from '../../lib/log';

/**
 * Handle `payment_intent.payment_failed`.
 *
 * The booking stays `pending` so the Buyer can retry from the checkout page;
 * the slot is only marked booked once a payment succeeds, so there is no slot
 * state to revert. `bookings.status` has no `failed` value at MVP — a
 * terminal `canceled` intent is surfaced via `payment_intent.canceled`.
 *
 * Returns normally (router acks 200) because this is a business outcome, not
 * a processing failure — Stripe should not redeliver it.
 */
export async function handlePaymentIntentFailed(event: Stripe.Event): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  log('info', 'webhook.payment_failed', {
    paymentIntentId: paymentIntent.id,
    status: paymentIntent.status,
    lastPaymentError: paymentIntent.last_payment_error?.message ?? null,
  });
}
