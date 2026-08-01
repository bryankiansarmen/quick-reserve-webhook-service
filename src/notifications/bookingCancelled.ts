import type { SupabaseClient } from '@supabase/supabase-js';

import { sendCancellationEmails } from '../lib/email';
import { log } from '../lib/log';

export interface BookingCancelledPayload {
  bookingId: string;
  cancelledBy: 'buyer' | 'seller';
}

interface CancelledBookingRow {
  id: string;
  status: string;
  amount_cents: number;
  buyer_id: string;
  listing_id: string;
  slot_id: string;
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
 * Assemble the cancellation-email context for a cancelled booking and send it
 * to both the Buyer and the Seller.
 *
 * Called from `POST /notifications/booking-cancelled`, which the Next.js app
 * hits best-effort after a successful cancel. This service is the only
 * component with the service-role key, which is required to resolve the
 * parties' email addresses from auth.users (the Next.js route only holds the
 * anon key, so it cannot).
 *
 * Data-lookup failures (missing listing, profile, or auth email) log and skip
 * rather than throw — the booking is already cancelled and a retry cannot fix
 * a permanent data gap. A Resend API failure throws so the router returns
 * non-2xx; the Next.js app treats a failure as non-fatal (email must never
 * block a cancellation).
 */
export async function handleBookingCancelled(
  payload: BookingCancelledPayload,
  supabase: SupabaseClient
): Promise<void> {
  const { bookingId, cancelledBy } = payload;

  const { data: bookingData, error: bookingError } = await supabase
    .from('bookings')
    .select('id, status, amount_cents, buyer_id, listing_id, slot_id')
    .eq('id', bookingId)
    .single();

  if (bookingError || !bookingData) {
    log('warn', 'notification.booking_lookup_failed', { bookingId });
    return;
  }

  if (bookingData.status !== 'cancelled') {
    log('warn', 'notification.booking_not_cancelled', {
      bookingId,
      status: bookingData.status,
    });
    return;
  }

  const booking = bookingData as CancelledBookingRow;

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
    log('warn', 'notification.listing_lookup_failed', { bookingId, listingId: booking.listing_id });
    return;
  }
  if (slotResult.error || !slotResult.data) {
    log('warn', 'notification.slot_lookup_failed', { bookingId, slotId: booking.slot_id });
    return;
  }
  if (buyerProfileResult.error || !buyerProfileResult.data) {
    log('warn', 'notification.buyer_profile_lookup_failed', { bookingId, buyerId: booking.buyer_id });
    return;
  }

  const listing = listingResult.data as ListingRow;
  const slot = slotResult.data as SlotRow;
  const buyerName = (buyerProfileResult.data as { full_name: string }).full_name;
  const buyerEmail = buyerUserResult.data.user?.email;
  if (!buyerEmail) {
    log('warn', 'notification.buyer_email_missing', { bookingId, buyerId: booking.buyer_id });
    return;
  }

  const [sellerProfileResult, sellerUserResult] = await Promise.all([
    supabase.from('profiles').select('full_name').eq('id', listing.seller_id).single(),
    supabase.auth.admin.getUserById(listing.seller_id),
  ]);

  if (sellerProfileResult.error || !sellerProfileResult.data) {
    log('warn', 'notification.seller_profile_lookup_failed', {
      bookingId,
      sellerId: listing.seller_id,
    });
    return;
  }

  const sellerName = (sellerProfileResult.data as { full_name: string }).full_name;
  const sellerEmail = sellerUserResult.data.user?.email;
  if (!sellerEmail) {
    log('warn', 'notification.seller_email_missing', {
      bookingId,
      sellerId: listing.seller_id,
    });
    return;
  }

  const sent = await sendCancellationEmails({
    bookingId: booking.id,
    buyerEmail,
    buyerName,
    sellerEmail,
    sellerName,
    listingTitle: listing.title,
    slotStart: slot.start_time,
    slotEnd: slot.end_time,
    amountCents: booking.amount_cents,
    cancelledBy,
  });

  if (sent) {
    log('info', 'notification.booking_cancelled_email_sent', {
      bookingId,
      listingId: booking.listing_id,
      cancelledBy,
    });
  }
}
