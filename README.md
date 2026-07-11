# Bot Jolyne

Discord bot for Kyou operations. Node.js + TypeScript + discord.js.

It bridges the systems the warehouse and admin teams already use — kyou.id, the machitan PDA, Google Sheets, Metabase, Notion — into Discord, where the work actually gets coordinated.

Deployed manually via Coolify. **No CI/CD: pushing does not release.**

## Features

### Fulfillment

- **Stuck-PICK triage** (`schedulers/pick-triage.ts`) — polls Metabase every 15 minutes. Orders that were printed but whose items still aren't picked after 24 hours get posted to Discord as **one message per order** (embed listing the stuck items) with a 3-option dropdown: still in the pick queue / item damaged / can't find it. Picking an option opens a modal for notes; the bot replies with a result embed (who reported, status, notes) and deletes the question message. The "damaged" option accepts an optional photo. Window is 24–30 hours — anything older belongs to the digest below.
- **Stale-order digest** (`schedulers/fulfillment-stale.ts`) — daily 09:00 WIB recap of orders stuck 3–30 days, grouped by stage (PRINT → PICK → PACK → RESI). Read-only, no buttons. Stage logic is deliberately identical to `App\Support\FulfillmentStale` in kyou.id — **change one, change the other**, or the admin badge and this digest will disagree.

### Warehouse (machitan PDA intake)

A small HTTP server (`machitan/httpServer.ts`) that accepts uploads from the PDA and other clients. Every route is behind a Bearer token.

| Route | Purpose |
| --- | --- |
| `POST /machitan/pick-proof` | Photo proof that an item was picked |
| `POST /machitan/pickup-proof` | Photo proof that a pickup parcel reached the store |
| `POST /machitan/ws-inbox` | Incoming WS items; daily report + opname recap |
| `/machitan/absen/*` | **Arrival check-in**: batches sent from the journal Sheet, reconciled in the warehouse, exported to Discord as Excel (RES / CONV / Ledger / Absen) |
| `GET /health` | Liveness check |

### Deliveree

A Chrome extension running in the browser of staff already logged into `webapp.deliveree.com`. It reads order and driver status off the page, notifies Discord, and **auto-retries** the "Coba Pesan Kembali" button when no driver is found — reporting every attempt (attempt number, delay, duration) and the driver details once one is assigned.

### Other

- **Birthday reminders** for admins, from Metabase.
- **Oripa live sessions** — `/live start` and `/live end` (selfie proof + insight screenshot), plus `/live-recap`.
- **Part-timer attendance** — clock in/out buttons.
- **Notion standup** — daily report upserted into the Work Journal.
- **Kyou Item Scanner** — extension for keyboard-wedge scanners: scan a barcode, the active tab jumps to that item on kyou.id.

## Slash commands

| Command | Purpose |
| --- | --- |
| `/ping`, `/server`, `/whoami` | Utilities (latency, server info, your Discord user ID) |
| `/birthday`, `/birthdaynow` | Admin birthdays |
| `/baito` | Part-timer clock in/out |
| `/opname` | WS opname recap |
| `/live start`, `/live end`, `/live-recap` | Oripa live sessions |
| `/task` | Create a Notion task |
| `/deliveree-status`, `/deliveree-cases`, `/deliveree-case`, `/deliveree-extension-health` | Deliveree |

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Development: `npm run dev` · Register slash commands: `npm run commands:deploy`

## Configuration

Core env (see `.env.example` for the rest):

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
METABASE_URL=
METABASE_EMAIL=
METABASE_PASSWORD=
METABASE_DATABASE_ID=2
```

> **Fulfillment settings (triage + digest) are not read from server env.** Their channel IDs and flags are forced in code in `src/config/env.ts` (same pattern as `BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID`), so changing a setting doesn't mean touching Coolify env. Edit that file and redeploy.

Two things that can bite you:

- **`MessageContent` is a privileged intent** and is required by the damaged-item photo flow. If it gets disabled in the Developer Portal, Discord refuses the login and **the entire bot dies** — not just the photo feature. Recovery: set `PICK_TRIAGE_PHOTO_ENABLED` to `"false"` in `src/config/env.ts`.
- **`data/` has no persistent volume.** The JSON stores (`pick-triage.json`, `deliveree-cases.json`, …) are wiped on every redeploy. That's a deliberate call; the cost is that items in the 24–30 hour band can be posted again after a redeploy.

## Chrome extensions

```bash
npm run deliveree:extension:pack      # → dist/deliveree-capture-extension
npm run kyou:scanner-extension:pack   # → dist/kyou-item-scanner-extension
```

On the staff machine: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the packed folder. For Deliveree, open the popup and set **Intake URL** (endpoint below), **Device ID** (`yugi-browser`, `cindy-browser`, or `rendy-browser`), and **Token** matching `DELIVEREE_EXTENSION_TOKEN` on the server → `Simpan` → `Test Intake` → verify with `/deliveree-status`.

```text
http://w9a2iwiolpi9wvw2fx6wlboo.43.134.34.13.sslip.io
```

The extension only sends operational fields (event, booking ID, status, page URL, service type, distance, job number, driver, plate, ETA). It never sends cookies, passwords, OTPs, photos, signatures, or payment data.

## Layout

```text
src/
  commands/     Slash commands
  config/       Env validation (and the settings forced in code)
  events/       Discord interaction router (dropdowns, modals, buttons)
  handlers/     Interactive flows (PICK triage, attendance, oripa live)
  schedulers/   Crons and pollers (PICK triage, stale digest, birthdays, …)
  machitan/     HTTP intake from the PDA (proofs, WS inbox, arrival check-in)
  services/     Metabase, Notion, JSON stores
extensions/     Chrome extensions (Deliveree, item scanner)
scripts/        Extension packers, triage channel purge, misc
```

Per-file detail: [`CODE_STRUCTURE.md`](CODE_STRUCTURE.md).
