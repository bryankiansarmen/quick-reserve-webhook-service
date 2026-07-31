import type { SupabaseClient } from '@supabase/supabase-js';

import { sendBookingConfirmationEmail } from '../../lib/email';
import { log } from '../../lib/log';

export interface ConfirmedBooking {
  id: string;
  buyer_id: string;
  listing_id: string;
  slot_id: string;
  amount_cents: number;
}

interface ListingRow {
  title: string;
  seller_id: string;
}

interface SlotRow {
  start_time: string;
  end_time: string;
}

/**
 * Assemble the confirmation email context for a confirmed booking and send it
 * to both the Buyer and the Seller.
 *
 * Called from `handlePaymentIntentSucceeded` on BOTH the fresh-confirmation
 * path and the idempotent replay path: a replay is the retry vehicle when the
 * first attempt's email send threw (Stripe redelivers, booking is already
 * `confirmed`, and the handler re-enters through the idempotent branch).
 * Duplicate sends are deduped by Resend via per-recipient idempotency keys
 * derived from the booking id, so a fully-processed replay produces no
 * duplicate email.
 *
 * Data-lookup failures (missing listing, profile, or auth email) log and skip
 * rather than throw — retrying cannot fix a permanent data gap and would spin
 * Stripe's retry loop uselessly. A Resend API failure, by contrast, throws so
 * the router returns non-2xx and the replay re-attempts the send.
 */
export async function sendBookingConfirmation(
  booking: ConfirmedBooking,
  supabase: SupabaseClient
): Promise<void> {
  const [listingResult, slotResult, buyerProfileResult, buyerUserResult] = await Promise.all([
    supabase.from('listings').select('title, seller_id').eq('id', booking.listing_id).single(),
    supabase
      .from('availability_slots')
      .select('start_time, end_time')
      .eq('id', booking.slot_id)
      .single(),
    supabase.from('profiles').select('full_name').eq('id', booking.buyer_id).single(),
    supabase.auth.admin.getUserById(booking.buyer_id),
  ]);

  if (listingResult.error || !listingResult.data) {
    log('warn', 'email.listing_lookup_failed', { bookingId: booking.id, listingId: booking.listing_id });
    return;
  }
  if (slotResult.error || !slotResult.data) {
    log('warn', 'email.slot_lookup_failed', { bookingId: booking.id, slotId: booking.slot_id });
    return;
  }
  if (buyerProfileResult.error || !buyerProfileResult.data) {
    log('warn', 'email.buyer_profile_lookup_failed', { bookingId: booking.id, buyerId: booking.buyer_id });
    return;
  }

  const listing = listingResult.data as ListingRow;
  const slot = slotResult.data as SlotRow;
  const buyerName = (buyerProfileResult.data as { full_name: string }).full_name;
  const buyerEmail = buyerUserResult.data.user?.email;
  if (!buyerEmail) {
    log('warn', 'email.buyer_email_missing', { bookingId: booking.id, buyerId: booking.buyer_id });
    return;
  }

  const [sellerProfileResult, sellerUserResult] = await Promise.all([
    supabase.from('profiles').select('full_name').eq('id', listing.seller_id).single(),
    supabase.auth.admin.getUserById(listing.seller_id),
  ]);

  if (sellerProfileResult.error || !sellerProfileResult.data) {
    log('warn', 'email.seller_profile_lookup_failed', { bookingId: booking.id, sellerId: listing.seller_id });
    return;
  }

  const sellerName = (sellerProfileResult.data as { full_name: string }).full_name;
  const sellerEmail = sellerUserResult.data.user?.email;
  if (!sellerEmail) {
    log('warn', 'email.seller_email_missing', { bookingId: booking.id, sellerId: listing.seller_id });
    return;
  }

  const sent = await sendBookingConfirmationEmail({
    bookingId: booking.id,
    buyerEmail,
    buyerName,
    sellerEmail,
    sellerName,
    listingTitle: listing.title,
    slotStart: slot.start_time,
    slotEnd: slot.end_time,
    amountCents: booking.amount_cents,
  });

  if (sent) {
    log('info', 'webhook.confirmation_email_sent', {
      bookingId: booking.id,
      listingId: booking.listing_id,
    });
  }
}
