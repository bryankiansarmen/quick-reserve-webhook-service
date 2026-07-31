import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createApp } from '../../app';

const { stripeMock, supabaseMock, emailMock } = vi.hoisted(() => ({
  stripeMock: { getStripe: vi.fn() },
  supabaseMock: { getSupabase: vi.fn() },
  emailMock: { sendBookingConfirmationEmail: vi.fn() },
}));

vi.mock('../../lib/stripe', () => stripeMock);
vi.mock('../../lib/supabase', () => supabaseMock);
vi.mock('../../lib/email', () => emailMock);

const WEBHOOK_SECRET = 'whsec_test_secret_for_signature_verification';
const STRIPE_KEY = 'sk_test_dummy_key_for_local_signature_verification';

const app = createApp();
const stripe = new Stripe(STRIPE_KEY);

const PI_ID = 'pi_test_123';
const BOOKING_ID = 'booking-123';
const SLOT_ID = 'slot-456';
const BUYER_ID = 'buyer-1';
const SELLER_ID = 'seller-2';

interface BookingSelectResult {
  data: { id: string; status: string; slot_id: string; buyer_id: string; listing_id: string; amount_cents: number } | null;
  error: { message: string } | null;
}

interface FakeSupabase {
  supabase: unknown;
  bookingUpdate: ReturnType<typeof vi.fn>;
  slotUpdate: ReturnType<typeof vi.fn>;
  fromCalls: string[];
  getUserById: ReturnType<typeof vi.fn>;
}

function createFakeSupabase(options: {
  bookingSelectResult: BookingSelectResult;
  slotSelectResult?: { data: { is_booked: boolean } | null; error: { message: string } | null };
  bookingUpdateError?: { message: string };
  slotUpdateError?: { message: string };
  listingResult?: { data: { title: string; seller_id: string } | null; error: { message: string } | null };
  slotFetchResult?: { data: { start_time: string; end_time: string } | null; error: { message: string } | null };
  buyerProfileResult?: { data: { full_name: string } | null; error: { message: string } | null };
  sellerProfileResult?: { data: { full_name: string } | null; error: { message: string } | null };
  buyerUserResult?: { data: { user: { email: string } | null } | null; error: { message: string } | null };
  sellerUserResult?: { data: { user: { email: string } | null } | null; error: { message: string } | null };
}): FakeSupabase {
  const bookingUpdate = vi.fn();
  const slotUpdate = vi.fn();
  const fromCalls: string[] = [];

  const slotSelectResult = options.slotSelectResult ?? { data: { is_booked: true }, error: null };
  const listingResult = options.listingResult ?? {
    data: { title: 'Sunlit Photography Studio', seller_id: SELLER_ID },
    error: null,
  };
  const slotFetchResult = options.slotFetchResult ?? {
    data: { start_time: '2026-08-01T10:00:00.000Z', end_time: '2026-08-01T12:00:00.000Z' },
    error: null,
  };
  const buyerProfileResult = options.buyerProfileResult ?? {
    data: { full_name: 'Buyer User' },
    error: null,
  };
  const sellerProfileResult = options.sellerProfileResult ?? {
    data: { full_name: 'Seller User' },
    error: null,
  };
  const buyerUserResult = options.buyerUserResult ?? {
    data: { user: { email: 'buyer@example.com' } },
    error: null,
  };
  const sellerUserResult = options.sellerUserResult ?? {
    data: { user: { email: 'seller@example.com' } },
    error: null,
  };

  const from = vi.fn((table: string) => {
    fromCalls.push(table);
    if (table === 'bookings') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue(options.bookingSelectResult),
          })),
        })),
        update: vi.fn((values: unknown) => {
          bookingUpdate(values);
          return {
            eq: vi.fn().mockResolvedValue({ error: options.bookingUpdateError ?? null }),
          };
        }),
      };
    }
    if (table === 'availability_slots') {
      return {
        select: vi.fn((columns: string) => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue(
              columns.includes('is_booked') ? slotSelectResult : slotFetchResult
            ),
          })),
        })),
        update: vi.fn((values: unknown) => {
          slotUpdate(values);
          return {
            eq: vi.fn().mockResolvedValue({ error: options.slotUpdateError ?? null }),
          };
        }),
      };
    }
    if (table === 'listings') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue(listingResult),
          })),
        })),
      };
    }
    if (table === 'profiles') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn((_column: string, id: string) => ({
            single: vi.fn().mockResolvedValue(
              String(id) === BUYER_ID ? buyerProfileResult : sellerProfileResult
            ),
          })),
        })),
      };
    }
    throw new Error(`Unexpected table queried by handler: ${table}`);
  });

  const getUserById = vi.fn((id: string) => {
    if (String(id) === BUYER_ID) {
      return Promise.resolve(buyerUserResult);
    }
    if (String(id) === SELLER_ID) {
      return Promise.resolve(sellerUserResult);
    }
    return Promise.resolve({ data: { user: null }, error: null });
  });

  return {
    supabase: { from, auth: { admin: { getUserById } } },
    bookingUpdate,
    slotUpdate,
    fromCalls,
    getUserById,
  };
}

function signedEvent(type: string, dataObject: Record<string, unknown>) {
  const payload = JSON.stringify({
    id: 'evt_test_1',
    object: 'event',
    type,
    data: { object: { id: PI_ID, object: 'payment_intent', ...dataObject } },
  });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature };
}

function postEvent(payload: string, signature?: string) {
  const req = request(app).post('/webhooks/stripe').set('Content-Type', 'application/json');
  if (signature !== undefined) {
    req.set('stripe-signature', signature);
  }
  return req.send(payload);
}

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  stripeMock.getStripe.mockReset();
  stripeMock.getStripe.mockReturnValue(stripe);
  supabaseMock.getSupabase.mockReset();
  emailMock.sendBookingConfirmationEmail.mockReset();
  emailMock.sendBookingConfirmationEmail.mockResolvedValue(undefined);
});

function pendingBooking() {
  return {
    data: {
      id: BOOKING_ID,
      status: 'pending',
      slot_id: SLOT_ID,
      buyer_id: BUYER_ID,
      listing_id: 'listing-7',
      amount_cents: 8500,
    },
    error: null,
  };
}

function confirmedBooking() {
  return {
    data: {
      id: BOOKING_ID,
      status: 'confirmed',
      slot_id: SLOT_ID,
      buyer_id: BUYER_ID,
      listing_id: 'listing-7',
      amount_cents: 8500,
    },
    error: null,
  };
}

describe('POST /webhooks/stripe', () => {
  it('rejects a request with an invalid Stripe-Signature header (400)', async () => {
    const { payload } = signedEvent('payment_intent.succeeded', { status: 'succeeded' });
    const res = await postEvent(payload, 't=9999999999,v1=bogus_signature');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(supabaseMock.getSupabase).not.toHaveBeenCalled();
  });

  it('rejects a request with a missing Stripe-Signature header (400)', async () => {
    const { payload } = signedEvent('payment_intent.succeeded', { status: 'succeeded' });
    const res = await postEvent(payload);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(supabaseMock.getSupabase).not.toHaveBeenCalled();
  });

  it('returns 500 when Stripe is not configured', async () => {
    stripeMock.getStripe.mockReturnValue(null);
    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when the webhook signing secret is missing', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('confirms the booking, marks its slot booked, and emails both parties on payment_intent.succeeded', async () => {
    const fake = createFakeSupabase({ bookingSelectResult: pendingBooking() });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, type: 'payment_intent.succeeded' });
    expect(fake.bookingUpdate).toHaveBeenCalledWith({ status: 'confirmed' });
    expect(fake.slotUpdate).toHaveBeenCalledWith({ is_booked: true });
    expect(fake.fromCalls).toEqual([
      'bookings',
      'bookings',
      'availability_slots',
      'listings',
      'availability_slots',
      'profiles',
      'profiles',
    ]);
    expect(emailMock.sendBookingConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(emailMock.sendBookingConfirmationEmail).toHaveBeenCalledWith({
      bookingId: BOOKING_ID,
      buyerEmail: 'buyer@example.com',
      buyerName: 'Buyer User',
      sellerEmail: 'seller@example.com',
      sellerName: 'Seller User',
      listingTitle: 'Sunlit Photography Studio',
      slotStart: '2026-08-01T10:00:00.000Z',
      slotEnd: '2026-08-01T12:00:00.000Z',
      amountCents: 8500,
    });
  });

  it('is idempotent on a replayed payment_intent.succeeded (no duplicate side effects)', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: confirmedBooking(),
      slotSelectResult: { data: { is_booked: true }, error: null },
    });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(200);
    expect(fake.bookingUpdate).not.toHaveBeenCalled();
    expect(fake.slotUpdate).not.toHaveBeenCalled();
    // A replay re-attempts the email (it is the retry vehicle for a send that
    // threw on the first attempt); duplicate delivery is prevented by Resend's
    // per-booking idempotency keys, asserted in lib/email tests.
    expect(emailMock.sendBookingConfirmationEmail).toHaveBeenCalledTimes(1);
  });

  it('self-heals a slot left unbooked by a partially-failed earlier attempt on replay', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: confirmedBooking(),
      slotSelectResult: { data: { is_booked: false }, error: null },
    });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(200);
    expect(fake.bookingUpdate).not.toHaveBeenCalled();
    expect(fake.slotUpdate).toHaveBeenCalledWith({ is_booked: true });
    expect(emailMock.sendBookingConfirmationEmail).toHaveBeenCalledTimes(1);
  });

  it('returns 500 (triggering a Stripe retry) when the booking is not found', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: { data: null, error: { message: 'No rows found' } },
    });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(emailMock.sendBookingConfirmationEmail).not.toHaveBeenCalled();
  });

  it('returns 500 (triggering a Stripe retry) when the booking update fails', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: pendingBooking(),
      bookingUpdateError: { message: 'connection reset' },
    });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(500);
    expect(fake.slotUpdate).not.toHaveBeenCalled();
    expect(emailMock.sendBookingConfirmationEmail).not.toHaveBeenCalled();
  });

  it('returns 500 (triggering a Stripe retry) when the slot update fails', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: pendingBooking(),
      slotUpdateError: { message: 'connection reset' },
    });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(500);
    expect(fake.bookingUpdate).toHaveBeenCalledWith({ status: 'confirmed' });
    expect(emailMock.sendBookingConfirmationEmail).not.toHaveBeenCalled();
  });

  it('returns 500 (triggering a Stripe retry) when the confirmation email fails to send', async () => {
    const fake = createFakeSupabase({ bookingSelectResult: pendingBooking() });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);
    emailMock.sendBookingConfirmationEmail.mockRejectedValueOnce(new Error('Resend is down'));

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(fake.bookingUpdate).toHaveBeenCalledWith({ status: 'confirmed' });
    expect(fake.slotUpdate).toHaveBeenCalledWith({ is_booked: true });
  });

  it('acks the webhook when a missing buyer email makes the email un-sendable (booking already saved)', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: pendingBooking(),
      buyerUserResult: { data: { user: null }, error: null },
    });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(200);
    expect(emailMock.sendBookingConfirmationEmail).not.toHaveBeenCalled();
  });

  it('leaves the booking pending on payment_intent.payment_failed', async () => {
    const { payload, signature } = signedEvent('payment_intent.payment_failed', {
      status: 'requires_payment_method',
      last_payment_error: { message: 'Your card was declined.' },
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, type: 'payment_intent.payment_failed' });
    expect(supabaseMock.getSupabase).not.toHaveBeenCalled();
  });

  it('acknowledges unhandled event types (200, no side effects)', async () => {
    const { payload, signature } = signedEvent('charge.succeeded', {
      id: 'ch_test_1',
      object: 'charge',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, type: 'charge.succeeded' });
    expect(supabaseMock.getSupabase).not.toHaveBeenCalled();
  });
});
