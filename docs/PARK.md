# Park system guide

The park modules sit on the same server, database, realtime bus and print layer as the restaurant
system (see [ARCHITECTURE.md](ARCHITECTURE.md)). Server code lives in `server/src/routes/park` and
`server/src/services/park`; web apps in `web/src/{parkweb,member,parkkiosk,counter,pos,gate,ride,park}`
and the admin pages in `web/src/admin/park`.

## ONE QR — ONE EXPERIENCE

Every guest has one **account** (member or guest) that owns the wallet, tickets, entitlements and
credentials. A credential (QR, wristband, member card) is just a key to that account, so the same
QR opens the gate, rides, pays at the POS, rents a locker and joins a virtual queue.

| Credential | Format | Notes |
|---|---|---|
| Static QR (tickets, wristbands, cards) | `TP:CODE.SIG` | HMAC-signed; printed on tickets and wristbands |
| Barcode | `CODE.SIG` | same signature, Code 128 |
| Digital member card | `TPD:…` | dynamic, expires after `member.digitalQrTtlSec` (screenshots stop working) |

Unsigned raw codes are rejected by kiosks and devices. Staff can still look up a code by hand
(counter → Cards / Verify). Walk-in sales and wristbands without a member get a **guest account**
automatically, so they can use the wallet straight away.

Credential lifecycle: issue → bind (counter *Bind wristband*) → active → suspend / lost / replace /
expire. Each change is audited and checked on every scan.

## Selling

- **Online** (`/park`): choose a date (the park's own "today", in the branch time zone) → packages →
  pay with PromptPay (QR with countdown, "I've paid" + slip, verified at the counter), card or gateway.
  The booking page updates in real time and shows the ticket QRs once paid.
- **Counter** (`/counter`): cart, member lookup, coupons, a manual discount (needs manager PIN),
  **split payment** (cash with change, card EDC, PromptPay, wallet scan, points, comp), and two
  receipts (staff + customer), tickets and wristbands.
- **Kiosk** (`/park-kiosk`): buy tickets, top up the wallet, check a card, join a virtual queue.
- **Member portal** (`/member`): digital card, tickets, wallet, rewards, virtual queue, food
  ordering paid from the wallet, bookings, membership, coupons, notifications, history, security.

Availability is checked on the server: date in the past / too far ahead, same-day cutoff, valid
days, blackout dates, sold out, sale window and channel. Each reason has a TH/EN/ZH message.

## Gates

Ten entrance lanes are seeded (`GATE-01` … `GATE-10`), each with a customer display device.

- `/gate/:gateId` — the customer display: scan with a USB scanner or the camera. It shows
  GRANTED / DENIED with the reason, the guest's name and tier, and remaining entries.
- `/gates` — the operator console for all lanes: AUTO / MANUAL mode, approve / deny, override
  (permission `gates.override`), open / close, resend open, reset, and park-wide emergency.
- Rules: valid date and zone, entry count, anti-passback (re-entry only after an exit, if the
  package allows it), a duplicate-scan window per gate, and capacity / live occupancy.
- Concurrent scans of the same credential are serialised (the ticket row is locked and the
  decision re-checked), so two lanes can never both grant the same single-entry ticket.

### Hardware drivers

| Driver | Use |
|---|---|
| `SIMULATOR` | Default. The display animates open → passage → close; good for demos and tests. |
| `EDGE_AGENT` | A small edge controller (the `print-agent` package) drives the turnstile relay. |

The edge controller is configured in `print-agent/.env`:

```bash
SERVER_URL=https://park.example.com
DEVICE_TOKEN=…            # Admin → Park → Devices → EDGE-01 → token
EDGE_RELAY=gpio           # simulate | gpio (libgpiod gpioset) | http (network relay board)
EDGE_GPIO_CHIP=gpiochip0  # pins per gate come from the device config, e.g. {"pins":{"GATE-01":17}}
EDGE_PASSAGE=auto         # auto = report PASSAGE after EDGE_PASSAGE_MS; none = the gate sensor reports it
```

It listens for `GATE_COMMAND` / `LOCKER_COMMAND` on its device socket, pulses the relay and reports
`OPENED`, `PASSAGE`, `CLOSED` or `FAULT` to `POST /api/park/hardware/gates/:id/events`. The same
process can also run the print agent (set `AGENT_TOKEN` as well).

## Rides, queues, lockers, POS

- **Ride scanner** (`/ride/:scanPointId`): checks the guest's entitlement (package rides, ride
  passes, rewards). If they have none, it offers buy-at-scanner, paid from the wallet or by staff.
- **Ride operator** (`/rides`): the virtual queue (call, skip, no-show), cycles, and open / closed /
  maintenance status.
- **Lockers** (`/locker`, or POS locker mode): rent paid from the wallet; the door opens through the
  same edge controller.
- **POS** (`/pos`): retail, restaurant (modifiers, kitchen tickets to the KDS) and locker modes.
  Payment works like the counter. Shifts open with a float; cash in / out and close-out with
  over / short (CASH_OUT needs a manager).

## Admin (`/admin/park/*`)

- **Dashboard**: per branch or all branches combined.
- **Live map** with occupancy.
- **Bookings**, with a calendar view.
- **Cards & wristbands** and the **slip verification** centre.
- **Members** and **transactions** (refund / void with a manager PIN).
- **Shifts**, **inventory**, **notifications**, and **security** (alerts, entry log, approvals).
- **Catalogue**: ticket types, packages (prices, rides, benefits, bundles, blackout dates), rides,
  scan points, zones, stores, tiers, membership products, rewards, coupons, gates, lockers (bulk
  create) and devices (pairing tokens).
- **Park settings**: 15 groups of settings, labelled in all three languages.
- **Reports**: export to PDF, Excel or CSV.

Promotions (Admin → Promotions) cover food and park sales. You can target them by channel, item
type, package, ticket type or tier, and set a minimum quantity, maximum units, advance days,
birthday-only, members-only, stackable and per-member usage.

## Languages — ไทย / English / 中文

Every screen can switch between Thai, English and Chinese with the language switcher. The choice is
saved per device in `localStorage.ui_lang`.

- Newer modules use `defineStrings(ns, {...})` + `useT(ns)` (`web/src/lib/lang.tsx`). Admin →
  Languages can override any `ns.key` text. These overrides reach devices in real time.
- The restaurant back office, cashier and KDS use `tt('English text')`
  (`web/src/lib/legacy-i18n.ts`), a Thai/Chinese dictionary keyed by the English text.
  `ttStatus(code)` translates status codes.
  The shared components (`PageHeader`, `Field`, `Tabs`, `Modal`, `Empty`, `Table` headers, toasts,
  dialogs) pass any plain string they receive through `tt()`. `StaffShell` re-mounts the screen when
  the language changes.
- Server reason and error codes (`packages/shared/src/park/i18n.ts`) carry TH/EN/ZH text, so
  DENIED reasons, availability errors and notifications follow the viewer's language.
- Catalogue data (packages, rides, products, rewards …) is entered in all three languages in its
  own editor. Receipts print in the configured receipt language.

## Fonts

Admin → Fonts sets the font for each surface, and per language within it:

- **Screens**: `web`, `kiosk`, `admin`, `counter`, `pos`, `cashier`, `gate`, `ride`, `kds`, `queue`.
- **Prints**: `receipt`, `ticket`, `wristband`, `kitchenTicket`.

Each surface has a family, weight, size, letter spacing and line height. It can also have a
different family for TH, EN or ZH (`byLang`). The family can be a Google Font or an uploaded
`.ttf` / `.otf` / `.woff` / `.woff2`.

Screens load the font through `useSurfaceFont` and set `<html lang>`, so the browser uses the right
glyphs. Printers that cannot render Thai or Chinese text get a bitmap made with the same fonts. Print
agents download uploaded fonts automatically.

## Printing — two receipts

Each sale queues a **staff copy** and a **customer copy**, plus tickets and wristbands if there are
any. They can print in two ways:

- **From the browser**, on the device itself: WebUSB, Web Bluetooth (BLE), or Web Serial for
  Bluetooth SPP.
- **Through the print agent**: LAN / Wi-Fi port 9100, USB, or serial / Bluetooth.

Both use the same ESC/POS or ZPL renderer (`renderPrintJob`). Jobs are deduplicated and retried;
a job that gets no answer is marked FAILED and needs a manual retry, which avoids printing twice.

## Smoke scripts

`scripts/.smoke/*.mjs` drive the running dev servers with Playwright. You need the API on :4000 and
Vite on :5173.

- `smoke4.mjs <outDir> [th|en|zh]` loads every park admin page and opens an editor.
- `smoke5.mjs <outDir> <lang> <paths…>` screenshots any list of pages in one language.
- `switch.mjs` checks that changing the language switches a staff screen live.
