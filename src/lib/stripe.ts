import Stripe from 'stripe';

let stripe: Stripe | null = null;

/**
 * Lazily initialize the Stripe server client.
 * Returns null when STRIPE_SECRET_KEY is not configured so callers can
 * degrade gracefully instead of crashing.
 */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return null;
  }
  if (!stripe) {
    stripe = new Stripe(key);
  }
  return stripe;
}
