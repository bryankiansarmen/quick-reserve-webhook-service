# Quick Reserve — Webhook Service

Standalone Node.js/Express service for the **Quick Reserve** marketplace that owns
Stripe webhook handling and transactional email delivery. It provides a stable,
always-listening endpoint for Stripe payment events — independent of the Next.js
app's serverless cold-start behavior — and sends booking confirmation/cancellation
emails via Resend using the Supabase service-role key.

## What It Does

- **Stripe webhooks** — verifies signatures and drives payment-state transitions
  (`payment_intent.succeeded`, `payment_intent.payment_failed`) on bookings. Idempotent:
  booking state is only re-applied if the current status requires it.
- **Internal notifications** — an authenticated endpoint the Next.js app calls to
  send booking-cancellation emails. Email delivery is best-effort by design: the
  booking is already cancelled, so a notification failure can never roll it back.
- **Health check** — `GET /health` for load-balancer/uptime monitoring.

## Tech Stack

- Node.js + Express
- Stripe (webhook signature verification)
- Supabase (service-role client for reading email addresses / updating booking state)
- Resend (transactional email)

## Getting Started

### Prerequisites

- Node.js 22+ (npm)

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the environment template and fill in your values:

   ```bash
   cp .env.example .env.local
   ```

   | Variable | Purpose |
   |---|---|
   | `PORT` | Server port (default `4000`) |
   | `SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (bypasses RLS) |
   | `STRIPE_SECRET_KEY` | Stripe secret key (test mode) |
   | `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |
   | `RESEND_API_KEY` | Resend API key for email delivery |
   | `FROM_EMAIL` | Sender override (defaults to `onboarding@resend.dev`) |
   | `INTERNAL_NOTIFICATION_TOKEN` | Shared secret verified on `x-internal-token`; must match the Next.js app's value |

   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `STRIPE_SECRET_KEY` are required
   to boot. The feature-level vars are validated at runtime and warn if unset.

3. Start the dev server (watch mode):

   ```bash
   npm run dev
   ```

   The service listens on [http://localhost:4000](http://localhost:4000).

### Testing Webhooks Locally

Use the Stripe CLI to forward events to the service:

```bash
stripe listen --forward-to localhost:4000/webhooks/stripe
```

The CLI prints a `whsec_...` secret; set it as `STRIPE_WEBHOOK_SECRET` in `.env.local`.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Liveness/health check |
| `POST` | `/webhooks/stripe` | Stripe signature | Payment-state webhook (Stripe-initiated) |
| `POST` | `/notifications/booking-cancelled` | `x-internal-token` | Send cancellation emails (app-initiated) |

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with watch mode (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled production server |
| `npm test` | Run the test suite (Vitest) |
| `npm run test:watch` | Run tests in watch mode |

## Docker

A multi-stage `Dockerfile` builds and runs the service on Node 22 Alpine (port 4000):

```bash
docker build -t quick-reserve-webhook-service .
docker run -p 4000:4000 --env-file .env.local quick-reserve-webhook-service
```

## Related

- [quick-reserve-web](https://github.com/bryankiansarmen/quick-reserve) — the Next.js marketplace web app this service supports
