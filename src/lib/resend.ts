import { Resend } from 'resend';

let resend: Resend | null = null;

/**
 * Lazily initialize the Resend client.
 * Returns null when RESEND_API_KEY is not configured so callers can degrade
 * gracefully (skip emailing, warn) instead of crashing the webhook handler.
 */
export function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return null;
  }
  if (!resend) {
    resend = new Resend(key);
  }
  return resend;
}
