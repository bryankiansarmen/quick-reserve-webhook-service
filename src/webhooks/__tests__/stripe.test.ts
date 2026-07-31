import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createApp } from '../../app';

const { stripeMock, supabaseMock } = vi.hoisted(() => ({
  stripeMock: { getStripe: vi.fn() },
  supabaseMock: { getSupabase: vi.fn() },
}));

vi.mock('../../lib/stripe', () => stripeMock);
vi.mock('../../lib/supabase', () => supabaseMock);

const WEBHOOK_SECRET = 'whsec_test_secret_for_signature_verification';
const STRIPE_KEY = 'sk_test_dummy_key_for_local_signature_verification';

const app = createApp();
const stripe = new Stripe(STRIPE_KEY);

const PI_ID = 'pi_test_123';
const BOOKING_ID = 'booking-123';
const SLOT_ID = 'slot-456';

interface BookingSelectResult {
  data: { id: string; status: string; slot_id: string } | null;
  error: { message: string } | null;
}

interface FakeSupabase {
  supabase: unknown;
  bookingUpdate: ReturnType<typeof vi.fn>;
  slotUpdate: ReturnType<typeof vi.fn>;
  fromCalls: string[];
}

function createFakeSupabase(options: {
  bookingSelectResult: BookingSelectResult;
  slotSelectResult?: { data: { is_booked: boolean } | null; error: { message: string } | null };
  bookingUpdateError?: { message: string };
  slotUpdateError?: { message: string };
}): FakeSupabase {
  const bookingUpdate = vi.fn();
  const slotUpdate = vi.fn();
  const fromCalls: string[] = [];

  const slotSelectResult = options.slotSelectResult ?? { data: { is_booked: true }, error: null };

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
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue(slotSelectResult),
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
    throw new Error(`Unexpected table queried by handler: ${table}`);
  });

  return { supabase: { from }, bookingUpdate, slotUpdate, fromCalls };
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
});

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

  it('confirms the booking and marks its slot booked on payment_intent.succeeded', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: {
        data: { id: BOOKING_ID, status: 'pending', slot_id: SLOT_ID },
        error: null,
      },
    });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, type: 'payment_intent.succeeded' });
    expect(fake.bookingUpdate).toHaveBeenCalledWith({ status: 'confirmed' });
    expect(fake.slotUpdate).toHaveBeenCalledWith({ is_booked: true });
    expect(fake.fromCalls).toEqual(['bookings', 'bookings', 'availability_slots']);
  });

  it('is idempotent on a replayed payment_intent.succeeded (no duplicate side effects)', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: {
        data: { id: BOOKING_ID, status: 'confirmed', slot_id: SLOT_ID },
        error: null,
      },
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
  });

  it('self-heals a slot left unbooked by a partially-failed earlier attempt on replay', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: {
        data: { id: BOOKING_ID, status: 'confirmed', slot_id: SLOT_ID },
        error: null,
      },
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
  });

  it('returns 500 (triggering a Stripe retry) when the booking update fails', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: {
        data: { id: BOOKING_ID, status: 'pending', slot_id: SLOT_ID },
        error: null,
      },
      bookingUpdateError: { message: 'connection reset' },
    });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(500);
    expect(fake.slotUpdate).not.toHaveBeenCalled();
  });

  it('returns 500 (triggering a Stripe retry) when the slot update fails', async () => {
    const fake = createFakeSupabase({
      bookingSelectResult: {
        data: { id: BOOKING_ID, status: 'pending', slot_id: SLOT_ID },
        error: null,
      },
      slotUpdateError: { message: 'connection reset' },
    });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const { payload, signature } = signedEvent('payment_intent.succeeded', {
      status: 'succeeded',
    });

    const res = await postEvent(payload, signature);

    expect(res.status).toBe(500);
    expect(fake.bookingUpdate).toHaveBeenCalledWith({ status: 'confirmed' });
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
