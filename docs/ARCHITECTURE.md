# Architecture

## Overview

```
 ┌───────────── devices (PWA, same codebase) ─────────────┐          ┌──────── on-site ────────┐
 │ Kiosk × N   Cashier × N   KDS × N   Queue TV   Admin   │          │ Print Agent (Node)      │
 │  │ WebUSB / Web Bluetooth / Web Serial / Android /      │          │  LAN :9100 · /dev/usb/lp│
 │  │ Desktop bridge print executors                       │          │  /dev/rfcomm · COMx     │
 └──┼──────────────── HTTPS + Socket.IO ──────────────────┘          └──────┬─────────────────┘
    ▼                                                                       │ Socket.IO + HTTPS
 ┌─────────────────────────── server (Fastify) ──────────────────────────────┴──┐
 │ REST API · RBAC · validation (zod) · idempotency · audit                       │
 │ services: orders · payments · kitchen · queue · stock · printing · reports     │
 │ realtime bus: Postgres LISTEN/NOTIFY → Socket.IO rooms (multi-instance safe)    │
 │ background: order expiry · print retries / stale claims · kiosk/agent health    │
 └──────────────────────────────────────┬─────────────────────────────────────────┘
                                         ▼
                                PostgreSQL (schema in server/src/db/migrations)
```

All state lives in PostgreSQL. Every device subscribes to Socket.IO rooms and refreshes on events;
on reconnect it resyncs over REST, and critical waits (kiosk payment screens) also poll, so a lost
event never leaves a screen stuck.

## Core workflow

```
Kiosk: language → DINE IN / TAKE AWAY → menu → customize → cart → payment
  POST /api/kiosk/orders  (clientOrderId = idempotency key; random 5-digit number reserved)
  POST /api/kiosk/orders/:id/payments {QR|CASH|CARD|OTHER}
QR:   kiosk shows PromptPay QR + countdown → "ตรวจสอบการชำระเงิน"
      → payment_verifications WAITING_VERIFICATION → PAYMENT_WAITING to cashier room (popup + sound)
      → cashier APPROVE → critical transaction → PAYMENT_APPROVED to kiosk room → "ชำระเงินสำเร็จ #48271"
      → cashier REJECT → PAYMENT_REJECTED → kiosk: verify again / change method / call staff
CASH: kiosk "กรุณาชำระเงินที่เคาน์เตอร์" (WAITING_CASH_PAYMENT) → cashier Exact/100/500/1000 + change → PAID
CARD: provider adapter → WAITING_CARD → PROCESSING → APPROVED/DECLINED/CANCELLED via signed webhook
Kitchen: NEW → START → PREPARING → DONE → READY (all stations) → queue display calls the number (TH/EN/ZH voice)
Pickup → COMPLETED → number released for reuse.
```

### Order states
`CREATED → WAITING_PAYMENT | WAITING_CASH_PAYMENT | WAITING_CARD → WAITING_VERIFICATION → PAID → CONFIRMED → NEW → PREPARING → READY → COMPLETED`,
plus `CANCELLED` (unpaid cancel / expiry / void) and `REFUNDED`. Every transition writes an `order_events` row
(the timeline on the order detail screen) and important staff actions write `audit_logs`.

### Critical payment transaction (`server/src/services/payments.ts → confirmPaymentTx`)
Inside one DB transaction:
1. `SELECT … FROM orders WHERE id=$1 FOR UPDATE` — serialises concurrent approvals / webhooks.
2. Already `PAID` → return `alreadyPaid` (no side effects).
3. Mark payment `PAID` (partial unique index `payments_one_paid_per_order` makes a second PAID impossible).
4. Cancel other open attempts / verifications; order → `PAID` → `CONFIRMED`.
5. Ensure the queue number is active; commit stock (unique per order+product+type movement).
6. Create kitchen orders per station (`UNIQUE(order_id, station_id)`), order → `NEW`.
7. Create print jobs with a deterministic `dedupe_key` (`UNIQUE`) — receipts × copies, kitchen tickets per printer/station.
8. COMMIT, then publish events (transactional outbox — nothing is announced unless it was committed).

Replays (double click, retry, duplicate webhook, two cashiers) therefore create no duplicate payment, order,
queue entry, kitchen ticket or receipt. HTTP endpoints additionally accept `Idempotency-Key`.

### Order numbers
Random `00000–99999` (`crypto.randomInt`). Before insert the server checks active numbers, then inserts into
`queue_numbers` whose partial unique index `(branch_id, number) WHERE active` is the race-safe guard; on conflict it
retries inside a savepoint. Internal identity is always the UUID `orders.id`; the 5-digit number is only for customers
and is released when the order completes / is cancelled.

## Printing

* **Jobs** (`print_jobs`): `QUEUED → PRINTING → PRINTED`, failures → `RETRYING` (exponential back-off) → `FAILED`;
  `CANCELLED`. Executors claim jobs with an atomic `UPDATE … WHERE status IN ('QUEUED','RETRYING') RETURNING`,
  so two executors can never print the same job. A claimed job with no result after `staleClaimSec` becomes `FAILED`
  (manual retry) instead of auto-reprinting — the outcome is unknown, so we avoid silent double printing.
  Failures emit `PRINTER_ERROR` ("Kitchen Printer Offline") to cashier/admin/kitchen. Retry reuses the same job row.
* **Routing**: item printer override → category printer → printer bound to the item's kitchen station → default
  kitchen printer. Items for different stations/printers produce separate tickets with the same order number.
* **Executors** (adapter architecture, no printer model hard-coded):
  * `AGENT` — print-agent: `TcpTransport` (LAN / Ethernet / Wi-Fi, raw 9100) and `DeviceFileTransport`
    (USB `/dev/usb/lp0`, serial, Bluetooth SPP `/dev/rfcomm0`, Windows `\\.\COM3` or raw shares).
  * `BROWSER` — WebUSB, Web Bluetooth (BLE), Web Serial on the device whose `host_device_id` matches.
  * `ANDROID` — `window.AndroidPrinter.print(printerJson, base64)` native bridge contract.
  * `DESKTOP` — `window.desktopBridge.print({printer, data})` (Electron / Tauri preload).
* **Rendering** (`packages/shared/src/print`): one document model → ESC/POS. `AUTO` mode rasterises the whole
  ticket to a 1-bit bitmap (`GS v 0`, Floyd–Steinberg) whenever Thai / Chinese / ฿ is present, using the font chosen
  in Admin → Fonts (browser canvas or Skia via `@napi-rs/canvas` in the agent, which downloads uploaded / Google fonts).
  `TEXT` mode uses the printer's built-in font for ASCII-only printers. 58 mm (384 dots) and 80 mm (576 dots).

## Payments & security

* PromptPay static / dynamic EMVCo payloads with CRC-16/CCITT (tested against the reference vector).
* Gateway QR and card terminals plug in via `PaymentProvider` (`server/src/services/providers.ts`). A sandbox provider
  ships for demos; its results go through the same signed webhook path:
  `X-Signature: t=<unix>,v1=hex(HMAC-SHA256(secret, t + "." + rawBody))`, timestamp tolerance (replay window) and
  `UNIQUE(provider, event_id)` de-duplication. Invalid signatures never touch the event table.
* Amount mismatch is rejected; money captured for an expired/cancelled order is flagged `LATE_PAYMENT_NEEDS_REFUND`.
* No card numbers / CVV are stored — only brand, last 4 (DB check constraint) and approval code.
* Passwords and PINs: bcrypt. Device tokens (kiosk / print agent): `id.secret`, only SHA-256 of the secret stored.
* JWT with per-user `token_version` (logout-all, role change and deactivation revoke sessions immediately).
* RBAC: roles → permissions, checked server-side on every route; nobody can grant a role/permission above their own.
  Branch-bound staff are pinned to their branch.
* Manager PIN approval (configurable): refund, void, manual payment approval, reprint, cancel paid order —
  approver must be manager level (≥ 70) and hold the permission; the approver is recorded in the audit log.
* Login rate limit + lock-out after N failures. CSV export neutralises formula injection. Uploads are type-restricted
  (no SVG) and served with `nosniff`.

## Offline / degraded mode (kiosk)

* App shell, menu images and fonts are cached by the service worker; bootstrap + menu snapshot in IndexedDB.
* Kiosk keeps working from the snapshot (schedules, sold-out and pricing computed locally with the shared engine).
* While offline only **cash at the counter** is offered; the order is stored in a local outbox as `SYNC_PENDING`
  with an offline reference shown to the customer. When connectivity returns it is synced automatically
  (same `clientOrderId` → server de-duplicates) and put into `WAITING_CASH_PAYMENT` for the cashier.
* Online-verified payments (QR / card) are **never** shown as successful without server confirmation.

## Multi-kiosk / multi-branch / scale-out

* Every kiosk, station, printer, stock row and (optionally) staff member belongs to a branch; queue numbers are unique
  per branch. Promotions can target branches.
* Server instances are stateless: realtime fan-out goes through Postgres `NOTIFY`, background jobs use row locks /
  idempotent updates, migrations use an advisory lock. Run as many instances as needed behind a load balancer with
  sticky sessions for Socket.IO (or WebSocket-only transport).

## Database tables

`branches, languages, roles, permissions, role_permissions, users, settings, fonts, kitchen_stations, print_agents,
kiosks, printers, menu_schedules, categories, products, product_translations, modifier_groups, modifiers,
product_modifier_groups, product_recommendations, promotions, stocks, stock_movements, orders, order_items,
order_item_modifiers, order_events, queue_numbers, payments, payment_verifications, payment_webhook_events, refunds,
kitchen_orders, print_jobs, audit_logs, idempotency_keys` — see `server/src/db/migrations/001_init.sql`.

## Extending

* **Real payment gateway / EDC terminal:** implement `PaymentProvider` (createQr / startCardCharge / cancel), register
  it, set `PAYMENT_WEBHOOK_SECRET_<PROVIDER>`, point the provider's callback to `/api/payments/webhook/<provider>`.
* **Android kiosk shell:** WebView loading `/kiosk` + a `JavascriptInterface` named `AndroidPrinter` implementing
  `print(printerJson, base64)` (Bluetooth / USB / Sunmi etc.). Set printer executor = ANDROID.
* **Desktop shell:** expose `desktopBridge.print` in an Electron/Tauri preload; set executor = DESKTOP.
