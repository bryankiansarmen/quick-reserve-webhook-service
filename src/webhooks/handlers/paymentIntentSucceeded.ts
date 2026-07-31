import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import { log } from '../../lib/log';

interface BookingRow {
  id: string;
  status: string;
  slot_id: string;
}

/**
 * Handle `payment_intent.succeeded`.
 *
 * Transitions the matching booking `pending → confirmed` and marks its slot
 * booked (`is_booked = true`). The booking is located by
 * `stripe_payment_intent_id`, which `POST /api/bookings` stores at creation
 * time — more reliable than trusting Payment Intent metadata.
 *
 * Idempotent: if the booking is already `confirmed` (Stripe redelivered the
 * event), nothing is re-applied, so automatic retries and dashboard replays
 * have no duplicate side effects.
 *
 * Throws on any failure so the router can return non-2xx and let Stripe retry.
 */
export async function handlePaymentIntentSucceeded(
  event: Stripe.Event,
  supabase: SupabaseClient
): Promise<void> {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const paymentIntentId = paymentIntent.id;

  const { data, error } = await supabase
    .from('bookings')
    .select('id, status, slot_id')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .single();

  if (error || !data) {
    throw new Error(`No booking found for payment intent ${paymentIntentId}`);
  }

  const booking = data as BookingRow;

  if (booking.status === 'confirmed') {
    // Stripe redelivered an event we already processed — no booking write and
    // no duplicate email. Self-heal the slot: if a previous attempt
    // partially failed (booking confirmed but the slot update errored before the
    // handler returned non-2xx), ensure the slot ends up booked. Writing only
    // when needed keeps a fully-processed replay a zero-write no-op.
    const { data: slot, error: slotFetchError } = await supabase
      .from('availability_slots')
      .select('is_booked')
      .eq('id', booking.slot_id)
      .single();

    if (slotFetchError || !slot || !slot.is_booked) {
      const { error: slotError } = await supabase
        .from('availability_slots')
        .update({ is_booked: true })
        .eq('id', booking.slot_id);

      if (slotError) {
        throw new Error(`Failed to mark slot ${booking.slot_id} booked: ${slotError.message}`);
      }
    }

    log('info', 'webhook.idempotent', { paymentIntentId, bookingId: booking.id });
    return;
  }

  const { error: bookingError } = await supabase
    .from('bookings')
    .update({ status: 'confirmed' })
    .eq('id', booking.id);

  if (bookingError) {
    throw new Error(`Failed to confirm booking ${booking.id}: ${bookingError.message}`);
  }

  const { error: slotError } = await supabase
    .from('availability_slots')
    .update({ is_booked: true })
    .eq('id', booking.slot_id);

  if (slotError) {
    throw new Error(`Failed to mark slot ${booking.slot_id} booked: ${slotError.message}`);
  }

  log('info', 'webhook.booking_confirmed', {
    paymentIntentId,
    bookingId: booking.id,
    slotId: booking.slot_id,
  });
}
