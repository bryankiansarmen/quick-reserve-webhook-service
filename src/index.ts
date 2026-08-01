import dotenv from 'dotenv';

import { createApp } from './app';
import { log } from './lib/log';

dotenv.config();
dotenv.config({ path: '.env.local' });

// Variables required for the service to boot. STRIPE_WEBHOOK_SECRET and
// RESEND_API_KEY are consumed by the webhook handler and email feature
// warned below instead of blocking the health endpoint.
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY'] as const;
const featureEnvVars = ['STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'INTERNAL_NOTIFICATION_TOKEN'] as const;

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

const app = createApp();
const port = process.env.PORT || 4000;

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
