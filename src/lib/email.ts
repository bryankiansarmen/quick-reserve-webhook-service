import { getResend } from './resend';
import { log } from './log';

export interface BookingConfirmationEmailData {
  bookingId: string;
  buyerEmail: string;
  buyerName: string;
  sellerEmail: string;
  sellerName: string;
  listingTitle: string;
  slotStart: string;
  slotEnd: string;
  amountCents: number;
}

const DEFAULT_FROM_EMAIL = 'onboarding@resend.dev';

function formatAmount(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

function formatSlotTime(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date);
}

function buildHtml(data: BookingConfirmationEmailData): string {
  const amount = formatAmount(data.amountCents);
  const start = formatSlotTime(data.slotStart);
  const end = formatSlotTime(data.slotEnd);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <h1 style="color: #4f46e5;">Booking confirmed</h1>
      <p>Hi ${escapeHtml(data.buyerName)},</p>
      <p>Your booking for <strong>${escapeHtml(data.listingTitle)}</strong> is confirmed.</p>
      <table style="border-collapse: collapse; margin: 16px 0; width: 100%;">
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Listing</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(data.listingTitle)}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Start</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${start} UTC</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">End</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${end} UTC</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Total</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${amount}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Booking ref</td><td style="padding: 8px;">${escapeHtml(data.bookingId)}</td></tr>
      </table>
      <p style="color: #666; font-size: 14px;">Thank you for booking with Quick Reserve. If you have any questions, contact the space owner.</p>
    </div>
  `;
}

function buildSellerHtml(data: BookingConfirmationEmailData): string {
  const amount = formatAmount(data.amountCents);
  const start = formatSlotTime(data.slotStart);
  const end = formatSlotTime(data.slotEnd);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <h1 style="color: #4f46e5;">New booking</h1>
      <p>Hi ${escapeHtml(data.sellerName)},</p>
      <p>You have a new booking for <strong>${escapeHtml(data.listingTitle)}</strong>.</p>
      <table style="border-collapse: collapse; margin: 16px 0; width: 100%;">
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Listing</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(data.listingTitle)}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Start</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${start} UTC</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">End</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${end} UTC</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Total</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${amount}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Booking ref</td><td style="padding: 8px;">${escapeHtml(data.bookingId)}</td></tr>
      </table>
      <p style="color: #666; font-size: 14px;">You can manage this booking from your seller dashboard.</p>
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send booking confirmation emails to both the Buyer and the Seller via
 * Resend. The two recipients get distinct messages: the Buyer a confirmation,
 * the Seller a "new booking" notice.
 *
 * Returns `true` when both emails were accepted by Resend, `false` when
 * RESEND_API_KEY is not configured (logged, and the booking is already
 * confirmed so retrying cannot fix a config gap).
 *
 * Throws when a Resend API call itself fails — that is a transient condition
 * worth surfacing as a non-2xx so Stripe retries and the send gets another
 * attempt (deduped by the per-recipient idempotency keys below).
 */
export interface BookingCancellationEmailData {
  bookingId: string;
  buyerEmail: string;
  buyerName: string;
  sellerEmail: string;
  sellerName: string;
  listingTitle: string;
  slotStart: string;
  slotEnd: string;
  amountCents: number;
  cancelledBy: 'buyer' | 'seller';
}

function buildCancellationHtml(data: BookingCancellationEmailData): string {
  const start = formatSlotTime(data.slotStart);
  const end = formatSlotTime(data.slotEnd);
  const line =
    data.cancelledBy === 'buyer'
      ? `Your booking for <strong>${escapeHtml(data.listingTitle)}</strong> was cancelled.`
      : `The space owner cancelled your booking for <strong>${escapeHtml(data.listingTitle)}</strong>.`;
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <h1 style="color: #4f46e5;">Booking cancelled</h1>
      <p>Hi ${escapeHtml(data.buyerName)},</p>
      <p>${line}</p>
      <table style="border-collapse: collapse; margin: 16px 0; width: 100%;">
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Listing</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(data.listingTitle)}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Start</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${start} UTC</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">End</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${end} UTC</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Booking ref</td><td style="padding: 8px;">${escapeHtml(data.bookingId)}</td></tr>
      </table>
      <p style="color: #666; font-size: 14px;">The slot has been released. If you have any questions, contact the space owner.</p>
    </div>
  `;
}

function buildCancellationSellerHtml(data: BookingCancellationEmailData): string {
  const start = formatSlotTime(data.slotStart);
  const end = formatSlotTime(data.slotEnd);
  const line =
    data.cancelledBy === 'seller'
      ? `You cancelled the booking for <strong>${escapeHtml(data.listingTitle)}</strong>.`
      : `The buyer cancelled their booking for <strong>${escapeHtml(data.listingTitle)}</strong>.`;
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
      <h1 style="color: #4f46e5;">Booking cancelled</h1>
      <p>Hi ${escapeHtml(data.sellerName)},</p>
      <p>${line}</p>
      <table style="border-collapse: collapse; margin: 16px 0; width: 100%;">
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Listing</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(data.listingTitle)}</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Start</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${start} UTC</td></tr>
        <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">End</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${end} UTC</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Booking ref</td><td style="padding: 8px;">${escapeHtml(data.bookingId)}</td></tr>
      </table>
      <p style="color: #666; font-size: 14px;">The slot has been released and is available to book again.</p>
    </div>
  `;
}

/**
 * Send cancellation emails to both the Buyer and the Seller via Resend.
 * Distinct messages per recipient; the cancelledBy flag picks the accurate
 * voice ("you cancelled" vs "the other party cancelled").
 *
 * Follows the same contract as `sendBookingConfirmationEmail`: returns `true`
 * when both emails were accepted, `false` when RESEND_API_KEY is not
 * configured (logged, non-fatal), and throws when a Resend API call fails so
 * the caller can surface a non-2xx. Duplicate sends are deduped by the
 * per-recipient idempotency keys below.
 */
export async function sendCancellationEmails(
  data: BookingCancellationEmailData
): Promise<boolean> {
  const resend = getResend();
  if (!resend) {
    log('warn', 'email.resend_unconfigured', { bookingId: data.bookingId });
    return false;
  }

  const from = process.env.FROM_EMAIL || DEFAULT_FROM_EMAIL;
  const subject = `Booking cancelled: ${data.listingTitle}`;
  const common = {
    from,
    subject,
  };

  const [buyerResult, sellerResult] = await Promise.all([
    resend.emails.send(
      {
        ...common,
        to: data.buyerEmail,
        html: buildCancellationHtml(data),
        text: `Your booking for ${data.listingTitle} was cancelled. Booking ref: ${data.bookingId}.`,
      },
      { idempotencyKey: `booking-cancellation-buyer-${data.bookingId}` }
    ),
    resend.emails.send(
      {
        ...common,
        to: data.sellerEmail,
        html: buildCancellationSellerHtml(data),
        text: `A booking for ${data.listingTitle} was cancelled. Booking ref: ${data.bookingId}.`,
      },
      { idempotencyKey: `booking-cancellation-seller-${data.bookingId}` }
    ),
  ]);

  if (buyerResult.error) {
    throw new Error(`Failed to send buyer cancellation email: ${buyerResult.error.message}`);
  }
  if (sellerResult.error) {
    throw new Error(`Failed to send seller cancellation email: ${sellerResult.error.message}`);
  }

  log('info', 'email.booking_cancellation_sent', {
    bookingId: data.bookingId,
    buyerEmail: data.buyerEmail,
    sellerEmail: data.sellerEmail,
    cancelledBy: data.cancelledBy,
  });

  return true;
}

export async function sendBookingConfirmationEmail(
  data: BookingConfirmationEmailData
): Promise<boolean> {
  const resend = getResend();
  if (!resend) {
    log('warn', 'email.resend_unconfigured', { bookingId: data.bookingId });
    return false;
  }

  const from = process.env.FROM_EMAIL || DEFAULT_FROM_EMAIL;
  const subject = `Booking confirmed: ${data.listingTitle}`;
  const common = {
    from,
    subject,
  };

  // Per-recipient idempotency keys derived from the booking id: if a webhook
  // replay re-enters this function after the first attempt already sent one or
  // both emails (e.g. the seller send threw after the buyer send succeeded),
  // Resend dedupes the repeat sends instead of delivering a second email.
  const [buyerResult, sellerResult] = await Promise.all([
    resend.emails.send(
      {
        ...common,
        to: data.buyerEmail,
        html: buildHtml(data),
        text: `Your booking for ${data.listingTitle} is confirmed. Booking ref: ${data.bookingId}.`,
      },
      { idempotencyKey: `booking-confirmation-buyer-${data.bookingId}` }
    ),
    resend.emails.send(
      {
        ...common,
        to: data.sellerEmail,
        html: buildSellerHtml(data),
        text: `You have a new booking for ${data.listingTitle}. Booking ref: ${data.bookingId}.`,
      },
      { idempotencyKey: `booking-confirmation-seller-${data.bookingId}` }
    ),
  ]);

  if (buyerResult.error) {
    throw new Error(`Failed to send buyer confirmation email: ${buyerResult.error.message}`);
  }
  if (sellerResult.error) {
    throw new Error(`Failed to send seller confirmation email: ${sellerResult.error.message}`);
  }

  log('info', 'email.booking_confirmation_sent', {
    bookingId: data.bookingId,
    buyerEmail: data.buyerEmail,
    sellerEmail: data.sellerEmail,
  });

  return true;
}
