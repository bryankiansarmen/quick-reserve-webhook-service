import { Router } from 'express';

const router = Router();

// Stripe webhook handler.
// Responds 501 so the route contract is explicit until the real handler lands.
router.post('/stripe', (_req, res) => {
  res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'Stripe webhook handler not yet implemented' } });
});

export { router as stripeRouter };
