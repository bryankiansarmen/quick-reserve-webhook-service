import { Router } from 'express';

import { getSupabase } from '../lib/supabase';
import { log } from '../lib/log';
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleBookingCancelled } from './bookingCancelled';

const router = Router();

/**
 * `POST /notifications/booking-cancelled` — internal app-to-service endpoint.
 *
 * Unlike the Stripe webhook (initiated by Stripe), this is invoked by the
 * Next.js app after a successful booking cancellation. Email delivery is
 * best-effort by design: the booking is already cancelled, so a failure here
 * must never be able to roll that back. The Next.js route logs and moves on
 * regardless of the response.
 *
 * Auth is a shared-secret header (`x-internal-token`) rather than a Stripe
 * signature; the endpoint returns 503 (not configured) instead of 401 when the
 * token is unset so a misconfigured deployment is obvious.
 */
router.post('/booking-cancelled', async (req, res) => {
  const token = process.env.INTERNAL_NOTIFICATION_TOKEN;
  if (!token) {
    log('error', 'notification.token_unconfigured', {});
    res.status(503).json({
      error: { code: 'NOT_CONFIGURED', message: 'Notification token is not configured' },
    });
    return;
  }

  if (req.header('x-internal-token') !== token) {
    log('warn', 'notification.invalid_token', {});
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Invalid internal token' },
    });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    log('error', 'notification.supabase_unconfigured', {});
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Database is not configured' },
    });
    return;
  }

  try {
    await handleBookingCancelled(req.body, supabase as unknown as SupabaseClient);
    res.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log('error', 'notification.processing_failed', { message });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Notification processing failed' },
    });
  }
});

export { router as notificationsRouter };
