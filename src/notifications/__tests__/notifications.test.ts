import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createApp } from '../../app';
import { handleBookingCancelled } from '../bookingCancelled';

const { supabaseMock, emailMock } = vi.hoisted(() => ({
  supabaseMock: { getSupabase: vi.fn() },
  emailMock: { sendCancellationEmails: vi.fn() },
}));

vi.mock('../../lib/supabase', () => supabaseMock);
vi.mock('../../lib/email', () => emailMock);

const TOKEN = 'internal_test_token';
const BOOKING_ID = 'booking-123';
const BUYER_ID = 'buyer-1';
const SELLER_ID = 'seller-2';

interface BookingRow {
  id: string;
  status: string;
  amount_cents: number;
  buyer_id: string;
  listing_id: string;
  slot_id: string;
}

interface FakeSupabase {
  supabase: unknown;
  fromCalls: string[];
  getUserById: ReturnType<typeof vi.fn>;
}

function createFakeSupabase(options: {
  bookingResult: { data: BookingRow | null; error: { message: string } | null };
  listingResult?: { data: { title: string; seller_id: string } | null; error: { message: string } | null };
  slotResult?: { data: { start_time: string; end_time: string } | null; error: { message: string } | null };
  buyerProfileResult?: { data: { full_name: string } | null; error: { message: string } | null };
  sellerProfileResult?: { data: { full_name: string } | null; error: { message: string } | null };
  buyerUserResult?: { data: { user: { email: string } | null } | null; error: { message: string } | null };
  sellerUserResult?: { data: { user: { email: string } | null } | null; error: { message: string } | null };
}): FakeSupabase {
  const fromCalls: string[] = [];

  const listingResult = options.listingResult ?? {
    data: { title: 'Sunlit Photography Studio', seller_id: SELLER_ID },
    error: null,
  };
  const slotResult = options.slotResult ?? {
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
    const select = vi.fn(() => ({
      eq: vi.fn(() => ({
        single: vi.fn(() => {
          if (table === 'bookings') return Promise.resolve(options.bookingResult);
          if (table === 'listings') return Promise.resolve(listingResult);
          if (table === 'availability_slots') return Promise.resolve(slotResult);
          if (table === 'profiles') {
            // Distinguished by the id passed to eq, resolved by call site below.
            return Promise.resolve(buyerProfileResult);
          }
          throw new Error(`Unexpected select table: ${table}`);
        }),
      })),
    }));

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
    return { select };
  });

  const getUserById = vi.fn((id: string) => {
    if (String(id) === BUYER_ID) return Promise.resolve(buyerUserResult);
    if (String(id) === SELLER_ID) return Promise.resolve(sellerUserResult);
    return Promise.resolve({ data: { user: null }, error: null });
  });

  return { supabase: { from, auth: { admin: { getUserById } } }, fromCalls, getUserById };
}

function cancelledBooking(): { data: BookingRow; error: null } {
  return {
    data: {
      id: BOOKING_ID,
      status: 'cancelled',
      amount_cents: 8500,
      buyer_id: BUYER_ID,
      listing_id: 'listing-7',
      slot_id: 'slot-5',
    },
    error: null,
  };
}

const app = createApp();

function postCancellation(body: unknown, token?: string) {
  const req = request(app).post('/notifications/booking-cancelled').send(body);
  if (token !== undefined) {
    req.set('x-internal-token', token);
  }
  return req;
}

beforeEach(() => {
  process.env.INTERNAL_NOTIFICATION_TOKEN = TOKEN;
  supabaseMock.getSupabase.mockReset();
  emailMock.sendCancellationEmails.mockReset();
  emailMock.sendCancellationEmails.mockResolvedValue(true);
});

describe('POST /notifications/booking-cancelled', () => {
  it('returns 503 when the notification token is not configured', async () => {
    delete process.env.INTERNAL_NOTIFICATION_TOKEN;

    const res = await postCancellation({ bookingId: BOOKING_ID, cancelledBy: 'buyer' }, TOKEN);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
    expect(supabaseMock.getSupabase).not.toHaveBeenCalled();
  });

  it('returns 401 when the internal token does not match', async () => {
    const res = await postCancellation(
      { bookingId: BOOKING_ID, cancelledBy: 'buyer' },
      'wrong_token'
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(supabaseMock.getSupabase).not.toHaveBeenCalled();
  });

  it('returns 500 when the database is not configured', async () => {
    supabaseMock.getSupabase.mockReturnValue(null);

    const res = await postCancellation({ bookingId: BOOKING_ID, cancelledBy: 'buyer' }, TOKEN);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('sends the cancellation emails and acks when enrichment succeeds', async () => {
    const fake = createFakeSupabase({ bookingResult: cancelledBooking() });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);

    const res = await postCancellation({ bookingId: BOOKING_ID, cancelledBy: 'seller' }, TOKEN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(emailMock.sendCancellationEmails).toHaveBeenCalledWith({
      bookingId: BOOKING_ID,
      buyerEmail: 'buyer@example.com',
      buyerName: 'Buyer User',
      sellerEmail: 'seller@example.com',
      sellerName: 'Seller User',
      listingTitle: 'Sunlit Photography Studio',
      slotStart: '2026-08-01T10:00:00.000Z',
      slotEnd: '2026-08-01T12:00:00.000Z',
      amountCents: 8500,
      cancelledBy: 'seller',
    });
  });

  it('returns 500 (non-fatal to the caller) when the email send throws', async () => {
    const fake = createFakeSupabase({ bookingResult: cancelledBooking() });
    supabaseMock.getSupabase.mockReturnValue(fake.supabase as unknown as SupabaseClient);
    emailMock.sendCancellationEmails.mockRejectedValueOnce(new Error('Resend is down'));

    const res = await postCancellation({ bookingId: BOOKING_ID, cancelledBy: 'buyer' }, TOKEN);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('handleBookingCancelled', () => {
  it('skips without throwing when the booking is missing', async () => {
    const fake = createFakeSupabase({
      bookingResult: { data: null, error: { message: 'No rows found' } },
    });

    await expect(
      handleBookingCancelled({ bookingId: BOOKING_ID, cancelledBy: 'buyer' }, fake.supabase as unknown as SupabaseClient)
    ).resolves.toBeUndefined();
    expect(emailMock.sendCancellationEmails).not.toHaveBeenCalled();
  });

  it('skips when the booking is not yet cancelled', async () => {
    const fake = createFakeSupabase({
      bookingResult: { data: { ...cancelledBooking().data, status: 'confirmed' }, error: null },
    });

    await handleBookingCancelled(
      { bookingId: BOOKING_ID, cancelledBy: 'buyer' },
      fake.supabase as unknown as SupabaseClient
    );

    expect(emailMock.sendCancellationEmails).not.toHaveBeenCalled();
  });

  it('skips when the buyer email cannot be resolved', async () => {
    const fake = createFakeSupabase({
      bookingResult: cancelledBooking(),
      buyerUserResult: { data: { user: null }, error: null },
    });

    await handleBookingCancelled(
      { bookingId: BOOKING_ID, cancelledBy: 'buyer' },
      fake.supabase as unknown as SupabaseClient
    );

    expect(emailMock.sendCancellationEmails).not.toHaveBeenCalled();
  });

  it('skips when the seller email cannot be resolved', async () => {
    const fake = createFakeSupabase({
      bookingResult: cancelledBooking(),
      sellerUserResult: { data: { user: null }, error: null },
    });

    await handleBookingCancelled(
      { bookingId: BOOKING_ID, cancelledBy: 'seller' },
      fake.supabase as unknown as SupabaseClient
    );

    expect(emailMock.sendCancellationEmails).not.toHaveBeenCalled();
  });
});
