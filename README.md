# Krua Hub — Self-Ordering Kiosk · POS Cashier · KDS · Queue Display · Admin

ระบบสั่งอาหารด้วยตนเอง (Self-Ordering Kiosk) + แคชเชียร์/ตรวจสอบการชำระเงิน + จอครัว (KDS) + จอเรียกคิว + ระบบหลังร้าน
แบบ Full-Stack ที่ทำงานจริง: Backend + PostgreSQL + Real-time + Printer Integration Layer + Offline mode + Multi-kiosk / Multi-branch

> Brand, logo, colors and UI are original ("Krua Hub" design system) — no third-party branding is used.

| Surface | URL | Who |
|---|---|---|
| Launcher | `/` | choose what this device is |
| Customer kiosk (PWA, touch) | `/kiosk` | customers (paired device) |
| Cashier / POS + Slip Verification Center | `/cashier`, `/cashier/verify` | cashier |
| Kitchen Display (all / per station) | `/kds`, `/kds/:stationId` | kitchen |
| Customer queue display (TV) | `/queue/:branchCode` | public screen |
| Admin back office | `/admin` | owner / admin / manager |
| Receipt QR order lookup | `/o/:orderId` | customer phone |

## Quick start (local)

Requirements: Node 20+ (22 recommended) and PostgreSQL 14+ (16 recommended).

```bash
npm install
cp server/.env.example server/.env        # set DATABASE_URL, JWT_SECRET …
npm run db:seed                           # migrations + base data + demo menu, prints device tokens
npm run dev                               # API :4000 + web :5173 (proxied)
```

Open http://localhost:5173 and pick a mode.

Demo logins (change them in Admin → Staff):

| Role | Username / password | Employee code / PIN |
|---|---|---|
| Owner | `admin` / `admin1234` | `OWN001` / `1234` |
| Manager | `manager` / `manager1234` | `MGR001` / `2222` |
| Cashier | `cashier` / `cashier1234` | `CSH001` / `1111` |
| Kitchen | `kitchen` / `kitchen1234` | `KIT001` / `3333` |

**Pair a kiosk:** the seed prints a token per kiosk (also in `server/.seed-output.json`).
Open `/kiosk` and paste it, or in Admin → Kiosks click 🔑 to get a QR code for the device.
Hidden maintenance panel on a kiosk: tap the bottom-right corner of the welcome screen 5×, then enter a manager PIN.

## Production (Docker)

```bash
cp .env.example .env            # set JWT_SECRET, POSTGRES_PASSWORD, PUBLIC_URL, webhook secrets
docker compose up -d --build
docker compose exec app node dist/seed.js     # first run (SEED_DEMO=false for an empty menu)
# on-site print agent for LAN/USB printers:
AGENT_TOKEN=… docker compose --profile agent up -d print-agent
```

One container serves the API, Socket.IO and the built PWA. Migrations run automatically at start
(guarded by a Postgres advisory lock, so several instances can start together). Put it behind HTTPS
(required for camera slip upload, WebUSB and Web Bluetooth).

## Repository layout

```
packages/shared   Types, pricing engine, promotions, PromptPay EMV QR, ESC/POS encoder,
                  receipt/kitchen-ticket layouts and the raster (bitmap) renderer — used by
                  server, browser and print agent so totals and prints are identical everywhere.
server            Fastify API, Socket.IO gateway, PostgreSQL schema/migrations, services
                  (orders, payments, kitchen, queue, stock, printing), background jobs, tests.
web               React PWA: kiosk, cashier, KDS, queue display, admin, browser printing layer.
print-agent       Local Node service driving LAN / USB / serial / Bluetooth-SPP printers.
scripts           e2e browser flow, fake network printer, icon renderer.
docs              Architecture, workflows, hardware & integration notes.
```

## Tests

```bash
npm test                       # shared unit tests, server integration tests (needs Postgres), agent tests
npm run typecheck
node scripts/e2e-flow.mjs out  # full browser flow against a running server (Playwright + Chromium)
node scripts/fake-printer.mjs out 9101   # fake :9100-style printer that decodes raster jobs to PNG
```

Server integration tests use `TEST_DATABASE_URL` (default `postgres://postgres@127.0.0.1:5432/kiosk_test`) and cover:
order numbers (random, unique among active orders), clientOrderId idempotency, modifier validation, promotions,
QR → verification → **6 concurrent approvals** producing exactly one payment / queue entry / kitchen ticket set / receipt,
rejection → kiosk notification → re-verify, cash change + idempotency keys, signed card webhooks (forged / stale / replayed),
kitchen → queue → pickup, stock reserve/commit/release, print claim/retry, manager-PIN refunds and every report + CSV/XLSX export.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, state machines, security model and hardware integration.
