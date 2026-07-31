import type express from 'express';

/**
 * Express request augmented with the raw request body.
 * `express.json()` captures it via the `verify` option in `src/index.ts`
 * so Stripe webhook signature verification can use the exact bytes Stripe signed.
 */
export interface RawBodyRequest extends express.Request {
  rawBody?: string;
}
