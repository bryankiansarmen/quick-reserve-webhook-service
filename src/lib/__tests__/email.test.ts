import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resendMock } = vi.hoisted(() => ({
  resendMock: { getResend: vi.fn() },
}));

vi.mock('../resend', () => resendMock);

import { sendBookingConfirmationEmail, sendCancellationEmails } from '../email';

const send = vi.fn();
const resendInstance = { emails: { send } };

const data = {
  bookingId: 'booking-123',
  buyerEmail: 'buyer@example.com',
  buyerName: 'Buyer User',
  sellerEmail: 'seller@example.com',
  sellerName: 'Seller User',
  listingTitle: 'Sunlit Photography Studio',
  slotStart: '2026-08-01T10:00:00.000Z',
  slotEnd: '2026-08-01T12:00:00.000Z',
  amountCents: 8500,
};

const cancellationData = {
  ...data,
  cancelledBy: 'buyer' as const,
};

beforeEach(() => {
  delete process.env.FROM_EMAIL;
  resendMock.getResend.mockReset();
  send.mockReset();
  send.mockResolvedValue({ data: { id: 'email-id' }, error: null });
});

describe('sendBookingConfirmationEmail', () => {
  it('returns false without sending when RESEND_API_KEY is not configured', async () => {
    resendMock.getResend.mockReturnValue(null);

    await expect(sendBookingConfirmationEmail(data)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns true when both emails are accepted', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);

    await expect(sendBookingConfirmationEmail(data)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends to the buyer and seller with the default from address and per-recipient idempotency keys', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);

    await sendBookingConfirmationEmail(data);

    expect(send).toHaveBeenCalledTimes(2);
    const [buyerCall, sellerCall] = send.mock.calls;
    expect(buyerCall[0]).toMatchObject({
      from: 'onboarding@resend.dev',
      to: 'buyer@example.com',
      subject: 'Booking confirmed: Sunlit Photography Studio',
    });
    expect(buyerCall[1]).toEqual({ idempotencyKey: 'booking-confirmation-buyer-booking-123' });
    expect(sellerCall[0]).toMatchObject({
      from: 'onboarding@resend.dev',
      to: 'seller@example.com',
      subject: 'Booking confirmed: Sunlit Photography Studio',
    });
    expect(sellerCall[1]).toEqual({ idempotencyKey: 'booking-confirmation-seller-booking-123' });
  });

  it('uses FROM_EMAIL env var when set', async () => {
    process.env.FROM_EMAIL = 'noreply@quickreserve.dev';
    resendMock.getResend.mockReturnValue(resendInstance);

    await sendBookingConfirmationEmail(data);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].from).toBe('noreply@quickreserve.dev');
  });

  it('throws when the buyer send returns an error', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);
    send
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'from address rejected', statusCode: 403, name: 'invalid_from_address' },
      })
      .mockResolvedValueOnce({ data: { id: 'email-id' }, error: null });

    await expect(sendBookingConfirmationEmail(data)).rejects.toThrow('buyer confirmation email');
  });

  it('throws when the seller send returns an error', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);
    send
      .mockResolvedValueOnce({ data: { id: 'email-id' }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'quota exceeded', statusCode: 429, name: 'rate_limit_exceeded' },
      });

    await expect(sendBookingConfirmationEmail(data)).rejects.toThrow('seller confirmation email');
  });

  it('includes booking details in the email bodies', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);

    await sendBookingConfirmationEmail(data);

    const [buyerCall, sellerCall] = send.mock.calls;
    const buyerHtml = buyerCall[0].html as string;
    expect(buyerHtml).toContain('Sunlit Photography Studio');
    expect(buyerHtml).toContain('$85.00');
    expect(buyerHtml).toContain('booking-123');
    expect(buyerHtml).toContain('Aug 1, 2026');
    const sellerHtml = sellerCall[0].html as string;
    expect(sellerHtml).toContain('New booking');
    expect(sellerHtml).toContain('Sunlit Photography Studio');
  });
});

describe('sendCancellationEmails', () => {
  it('returns false without sending when RESEND_API_KEY is not configured', async () => {
    resendMock.getResend.mockReturnValue(null);

    await expect(sendCancellationEmails(cancellationData)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns true when both emails are accepted', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);

    await expect(sendCancellationEmails(cancellationData)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends to the buyer and seller with per-recipient cancellation idempotency keys', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);

    await sendCancellationEmails(cancellationData);

    expect(send).toHaveBeenCalledTimes(2);
    const [buyerCall, sellerCall] = send.mock.calls;
    expect(buyerCall[0]).toMatchObject({
      from: 'onboarding@resend.dev',
      to: 'buyer@example.com',
      subject: 'Booking cancelled: Sunlit Photography Studio',
    });
    expect(buyerCall[1]).toEqual({
      idempotencyKey: 'booking-cancellation-buyer-booking-123',
    });
    expect(sellerCall[0]).toMatchObject({
      from: 'onboarding@resend.dev',
      to: 'seller@example.com',
      subject: 'Booking cancelled: Sunlit Photography Studio',
    });
    expect(sellerCall[1]).toEqual({
      idempotencyKey: 'booking-cancellation-seller-booking-123',
    });
  });

  it('throws when the buyer send returns an error', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);
    send
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'from address rejected', statusCode: 403, name: 'invalid_from_address' },
      })
      .mockResolvedValueOnce({ data: { id: 'email-id' }, error: null });

    await expect(sendCancellationEmails(cancellationData)).rejects.toThrow(
      'buyer cancellation email'
    );
  });

  it('throws when the seller send returns an error', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);
    send
      .mockResolvedValueOnce({ data: { id: 'email-id' }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'quota exceeded', statusCode: 429, name: 'rate_limit_exceeded' },
      });

    await expect(sendCancellationEmails(cancellationData)).rejects.toThrow(
      'seller cancellation email'
    );
  });

  it('tells each party who cancelled in the email bodies', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);

    await sendCancellationEmails(cancellationData);

    const [buyerCall, sellerCall] = send.mock.calls;
    expect(buyerCall[0].html).toContain('was cancelled');
    expect(buyerCall[0].html).toContain('Sunlit Photography Studio');
    expect(buyerCall[0].html).toContain('booking-123');
    expect(sellerCall[0].html).toContain('The buyer cancelled their booking');
  });

  it('reflects a seller-initiated cancellation in the bodies', async () => {
    resendMock.getResend.mockReturnValue(resendInstance);

    await sendCancellationEmails({ ...cancellationData, cancelledBy: 'seller' });

    const [buyerCall, sellerCall] = send.mock.calls;
    expect(buyerCall[0].html).toContain('The space owner cancelled your booking');
    expect(sellerCall[0].html).toContain('You cancelled the booking');
  });
});
