import express from 'express';
import dotenv from 'dotenv';

import { stripeRouter } from './webhooks/stripe';

dotenv.config();
dotenv.config({ path: '.env.local' });

type LogLevel = 'info' | 'warn' | 'error';

const log = (level: LogLevel, event: string, meta: Record<string, unknown> = {}): void => {
  const entry = JSON.stringify({
    level,
    timestamp: new Date().toISOString(),
    service: 'webhook-service',
    event,
    meta,
  });
  if (level === 'error') {
    console.error(entry);
  } else if (level === 'warn') {
    console.warn(entry);
  } else {
    console.log(entry);
  }
};

// Variables required for the service to boot. STRIPE_WEBHOOK_SECRET and
// RESEND_API_KEY are consumed by the webhook handler and email feature
// warned below instead of blocking the health endpoint.
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY'] as const;
const featureEnvVars = ['STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY'] as const;

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    log('error', 'env.missing', { envVar });
    process.exit(1);
  }
}

for (const envVar of featureEnvVars) {
  if (!process.env[envVar]) {
    log('warn', 'env.missing', { envVar });
  }
}

interface RawBodyRequest extends express.Request {
  rawBody?: string;
}

const app = express();
const port = process.env.PORT || 4000;

// Security & parsing middleware
app.use(
  express.json({
    verify: (req, _res, buf) => {
      // Store raw body for Stripe signature verification
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

// Start server with error handling
const server = app
  .listen(port, () => {
    log('info', 'server.started', { port });
  })
  .on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log('error', 'server.port_in_use', { port });
      process.exit(1);
    }
    log('error', 'server.error', { message: err.message });
    process.exit(1);
  });

// Graceful shutdown
const shutdown = (): void => {
  log('info', 'server.shutdown', {});
  server.close(() => {
    log('info', 'server.closed', {});
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    log('error', 'server.force_shutdown', {});
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
