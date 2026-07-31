import express from 'express';

import { stripeRouter } from './webhooks/stripe';
import { log } from './lib/log';
import type { RawBodyRequest } from './types';

/**
 * Build the Express app without starting a listener, so tests can exercise
 * it via supertest. `index.ts` is responsible for boot-time env validation
 * and starting the server.
 */
export function createApp(): express.Express {
  const app = express();

  // Capture the raw request body for Stripe signature verification. The
  // signature must be computed over the exact bytes Stripe signed, which
  // the parsed `req.body` does not preserve.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf.toString();
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));

  // Request logging
  app.use((req, _res, next) => {
    log('info', 'request', { method: req.method, path: req.path });
    next();
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Stripe webhooks
  app.use('/webhooks', stripeRouter);

  return app;
}
