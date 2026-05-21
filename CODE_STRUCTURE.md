# Bot-Jolyne Code Structure

This document maps the main server process, Discord bot, Deliveree intake/webhook-style HTTP server, and Chrome extensions in this repository.

## Runtime Overview

Bot-Jolyne is a TypeScript Node.js project with three main runtime surfaces:

1. **Discord bot gateway**
   - Entry: `src/index.ts`
   - Built output: `dist/index.js`
   - Handles slash commands, Discord buttons, scheduled birthday messages, Deliveree alerts, and Deliveree extension intake when enabled.

2. **Deliveree extension intake server**
   - Main integrated server: started by `src/index.ts` through `startDelivereeExtensionIntake()`.
   - Intake-only server: `src/deliveree-intake.ts`, built to `dist/deliveree-intake.js`.
   - Receives HTTP requests from the Chrome extension at `/deliveree/extension/*`.

3. **Chrome extensions**
   - Deliveree operational monitor: `extensions/deliveree-capture`.
   - Kyou Scanner Partner: `extensions/kyou-item-scanner-opener`.

## Root Files

| Path | Purpose |
| --- | --- |
| `package.json` | NPM scripts, dependencies, and runtime commands. |
| `tsconfig.json` | TypeScript build configuration. |
| `Dockerfile` | Production image; builds TypeScript and runs `npm start` / `dist/index.js`. |
| `.env.example` | Example environment variables. |
| `.env` | Local runtime environment. Do not commit secrets. |
| `README.md` | Existing project documentation and usage notes. |
| `data/` | Local persistent runtime files such as Deliveree cases. |
| `dist/` | Compiled TypeScript output and packed extension outputs. |
| `scripts/` | Utility scripts for extension packaging and icon generation. |

## NPM Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `dev` | `tsx watch src/index.ts` | Run the Discord bot in watch mode. |
| `start` | `node dist/index.js` | Run the compiled Discord bot/server. |
| `build` | `tsc` | Compile TypeScript into `dist/`. |
| `test` | `node --import tsx --test "src/**/*.test.ts"` | Run all Node test files. |
| `commands:deploy` | `tsx src/deploy-commands.ts` | Register slash commands to Discord guild. |
| `deliveree:login` | `tsx src/deliveree-login.ts` | Manual Playwright login helper for Deliveree web monitoring. |
| `deliveree:intake` | `node dist/deliveree-intake.js` | Run only the Deliveree extension intake server without Discord gateway. |
| `deliveree:extension:pack` | `node scripts/pack-deliveree-extension.js` | Copy Deliveree extension files into `dist/deliveree-capture-extension`. |
| `kyou:scanner-extension:pack` | `node scripts/pack-kyou-item-scanner-extension.js` | Copy Kyou Scanner Partner extension into `dist`. |

## Main Discord Bot Server

### Entry Point

`src/index.ts`

Responsibilities:

- Starts the mock Deliveree poller.
- Creates a Discord client when `DISCORD_TOKEN` exists.
- Registers slash commands on startup via `registerGuildSlashCommands()`.
- Starts the birthday scheduler.
- Starts the Deliveree extension intake server.
- Starts the optional Deliveree web monitor.
- Routes Discord interactions to `handleInteractionCreate()`.

Main startup flow:

```text
src/index.ts
→ registerGuildSlashCommands()
→ client.login(DISCORD_TOKEN)
→ ClientReady
  → startBirthdayNowScheduler()
  → startDelivereeExtensionIntake()
  → startDelivereeWebMonitor()
```

### Discord Events

| Path | Purpose |
| --- | --- |
| `src/events/ready.ts` | Logs the logged-in Discord user. |
| `src/events/interaction-create.ts` | Handles slash commands and button interactions. |

`src/events/interaction-create.ts` routes:

- Deliveree buttons to `handleDelivereeButtonInteraction()`.
- Mock order buttons to `handleMockOrderButtonInteraction()`.
- Chat input commands to the command map in `src/commands/index.ts`.

## Slash Commands

All commands are collected in `src/commands/index.ts`.

| Command File | Command | Purpose |
| --- | --- | --- |
| `src/commands/ping.ts` | `/ping` | Basic bot health check. |
| `src/commands/server.ts` | `/server` | Server/guild info command. |
| `src/commands/whoami.ts` | `/whoami` | Shows caller identity/access context. |
| `src/commands/birthday.ts` | `/birthday` | Fetches birthday admin list from Metabase. |
| `src/commands/birthday-now.ts` | `/birthdaynow`, `/birthdaynowtest` | Sends or previews today's birthday embed. |
| `src/commands/deliveree-status.ts` | `/deliveree-status` | Shows latest Deliveree extension status; supports `device` option. |
| `src/commands/deliveree-extension-health.ts` | `/deliveree-extension-health` | Summarizes extension intake state, devices, and cases. |
| `src/commands/deliveree-case.ts` | `/deliveree-case` | Shows one Deliveree recovery case. |
| `src/commands/deliveree-cases.ts` | `/deliveree-cases` | Lists Deliveree recovery cases. |
| `src/commands/deliveree-prepare-reorder.ts` | `/deliveree-prepare-reorder` | Legacy/guarded reorder preparation flow. |
| `src/commands/deliveree-controls.ts` | Button handler | Handles Deliveree manual control buttons, including Auto Retry shutdown. |
| `src/commands/mock-order.ts` | Mock order command | Generates mock Deliveree order flows. |
| `src/commands/mock-order-controls.ts` | Mock button handler | Handles mock order buttons. |

### Slash Command Deployment

`src/deploy-commands.ts` uses `src/services/slash-commands.ts` to register commands.

```text
npm run commands:deploy
```

## Deliveree Extension Intake / Webhook Server

The Deliveree Chrome extension sends HTTP requests to the intake server. It is webhook-like, but it is initiated by the extension rather than by Deliveree.

### Integrated Intake

`src/deliveree/extensionIntake.ts`

Started from the Discord bot by:

```ts
startDelivereeExtensionIntake(client)
```

Important environment variables:

| Env | Purpose |
| --- | --- |
| `DELIVEREE_EXTENSION_ENABLED` | Enables the intake server. |
| `DELIVEREE_EXTENSION_HOST` | Bind host, e.g. `0.0.0.0` for container/server use. |
| `DELIVEREE_EXTENSION_PORT` | Intake port, default `3001`. |
| `DELIVEREE_EXTENSION_TOKEN` | Bearer token required from extension. |
| `DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS` | Comma-separated allowed extension devices. |
| `DELIVEREE_INTAKE_DISCORD_ENABLED` | Enables Discord REST notifications in intake-only mode. |
| `DELIVEREE_ALERT_CHANNEL_ID` | Discord channel for Deliveree alerts. |

### Intake-only Server

`src/deliveree-intake.ts`

Use when only the HTTP intake is needed without the Discord gateway client:

```text
npm run build
npm run deliveree:intake
```

### HTTP Routes

Implemented in `handleDelivereeExtensionHttpRequest()` inside `src/deliveree/extensionIntake.ts`.

| Route | Method | Purpose |
| --- | --- | --- |
| `/deliveree/extension/health` | `GET` / `POST` | Checks local/server intake connectivity. Requires auth. |
| `/deliveree/extension/page-state` | `POST` | Receives heartbeat/page-state from extension. |
| `/deliveree/extension/status` | `POST` | Receives actionable status events such as order created or retry clicked. |
| `/deliveree/extension/test-discord` | `POST` | Sends a Discord test notification. |
| `/deliveree/extension/commands` | `POST` | Extension polls for commands, such as turning off Auto Retry. |

### Auth and Device Safety

The intake requires:

- Header `Authorization: Bearer <DELIVEREE_EXTENSION_TOKEN>`.
- Header `X-Deliveree-Device-Id: <device-id>`.
- Device ID must be included in `DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS`.

### Payload Parsing

`src/deliveree/extensionDomExtractor.ts`

Defines:

- `DelivereeExtensionStatusPayload`
- `DelivereeExtensionPageStatePayload`
- Zod validation schemas
- HTML/snapshot parsing helpers for tests and fixtures

Accepted event types include:

- `order_created`
- `order_failed`
- `driver_retry_detected`
- `driver_retry_clicked`
- `driver_assigned_after_retry`
- `driver_retry_page_changed`
- `driver_retry_paused`

### Case Storage

`src/deliveree/caseStore.ts`

Stores recovery cases in JSON format. Default path:

```text
data/deliveree-cases.json
```

Stores:

- booking ID
- device ID
- current status
- last heartbeat
- service, distance, destination count, job number
- driver info when detected
- action log
- retry count/attempt metadata
- Discord alert message metadata

Runtime factory:

`src/deliveree/liveRuntime.ts`

```ts
createDelivereeCaseStore()
createDelivereeWebClient()
```

### Discord Alert Embeds

`src/deliveree/extensionIntake.ts`

Builds and sends embeds for extension events.

Important notification cases:

| Event | Meaning |
| --- | --- |
| `order_created` | Order detected and monitoring begins. |
| `driver_retry_detected` | No driver was found; retry state detected. |
| `driver_retry_clicked` | Extension clicked `Coba Pesan Kembali`. |
| `driver_assigned_after_retry` | Driver was found after retry. |
| `driver_retry_paused` | Auto Retry paused from command or safety condition. |

### Discord REST Notification Mode

For intake-only mode, the notifier can send embeds using Discord REST instead of a gateway client.

Related code:

- `DiscordBotDelivereeExtensionNotifier` in `src/deliveree/extensionIntake.ts`
- `handleDelivereeExtensionDiscordTest()` in `src/deliveree/extensionIntake.ts`

## Deliveree Chrome Extension

Path:

```text
extensions/deliveree-capture
```

Packed output:

```text
dist/deliveree-capture-extension
```

Pack command:

```text
npm run deliveree:extension:pack
```

### Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | Chrome extension manifest. |
| `content.js` | Runs on `https://webapp.deliveree.com/*`; reads page state and performs Auto Retry. |
| `background.js` | Sends data to intake, stores logs, handles command polling and popup tests. |
| `popup.html` | Extension popup UI. |
| `popup.js` | Popup settings, test buttons, endpoint presets. |
| `popup.css` | Popup styling. |
| `icons/` | Extension icons. |
| `assets/popup-silhouette.png` | Popup visual background. |

### Permissions

Configured in `manifest.json`:

- `activeTab`
- `alarms`
- `scripting`
- `storage`

Host permissions include:

- `https://webapp.deliveree.com/*`
- `http://127.0.0.1/*`
- `http://localhost/*`

If the extension is used with a public remote intake URL, that remote host must also be included in `host_permissions` if Chrome blocks requests.

### Popup Settings

Default values are in `popup.js`:

| Setting | Purpose |
| --- | --- |
| `enabled` | Enables monitoring. |
| `autoRetry` | Enables automatic clicking of `Coba Pesan Kembali`. |
| `intakeUrl` | Local or remote intake base URL. |
| `deviceId` | Device identifier, e.g. `yugi-browser`, `cindy-browser`, `rendy-browser`. |
| `token` | Token matching `DELIVEREE_EXTENSION_TOKEN`. |

Popup has quick endpoint buttons:

- `Local 127`: `http://127.0.0.1:3001`
- `Remote Ready`: placeholder `https://deliveree-intake.kyou.id`

### Content Script Flow

`extensions/deliveree-capture/content.js`

Main responsibilities:

1. Detect booking ID from detail page, title, completed page text, or URL path.
2. Detect status from DOM text.
3. Detect active orders from homepage/top-nav dropdown.
4. Build payload/page-state objects.
5. Send status/page-state to background script.
6. Watch DOM changes with `MutationObserver`.
7. Run Auto Retry when enabled.

Statuses detected include:

- `searching_driver`
- `active_booking`
- `no_driver_found`
- `driver_assigned`
- `going_to_pickup`
- `waiting_pickup`
- `going_to_destination`
- `arrived_destination`
- `cancelled`
- `completed`
- `login_required`
- `captcha_or_security_challenge`

### Auto Retry Flow

Auto Retry is local to the browser and does not require a remote endpoint to click.

```text
No driver modal detected
→ find visible button with text exactly `Coba Pesan Kembali`
→ wait random 8–15 seconds
→ send `driver_retry_clicked` event
→ click button
→ continue watching page
→ when driver found, send `driver_assigned_after_retry`
```

Important selector:

```js
normalizeKey(textOf(btn)) === "coba pesan kembali"
```

The extension avoids clicking when:

- Auto Retry is disabled.
- Booking ID changed.
- Login or security/captcha challenge is detected.
- Retry button is not visible/enabled.

### Background Script Flow

`extensions/deliveree-capture/background.js`

Responsibilities:

- Reads extension settings from `chrome.storage.local`.
- Sends `/status` payloads to intake.
- Sends `/page-state` heartbeat payloads to intake.
- Runs popup test actions.
- Polls `/commands` for remote commands such as disabling Auto Retry.
- Stores logs and last results for popup history.

## Kyou Scanner Partner Chrome Extension

Path:

```text
extensions/kyou-item-scanner-opener
```

Packed output is produced by:

```text
npm run kyou:scanner-extension:pack
```

### Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | Chrome extension manifest. |
| `content.js` | Captures scanner input and opens/searches Kyou item pages. |
| `popup.html` | Settings popup. |
| `popup.js` | Popup setting logic and test controls. |
| `popup.css` | Popup styling. |
| `icons/` | Extension icons. |
| `assets/popup-silhouette.png` | Popup background. |

### Behavior

The extension is for teams using scanner hardware instead of PDA devices.

Core functions:

- Read keyboard scanner input.
- Open Kyou item pages for valid Kyou IDs.
- Search long JAN/barcode input on Kyou search.
- Optional copy Kyou ID to clipboard after resolving an item.
- Toast feedback on matching pages.
- Popup test actions for scan behavior.

## Birthday / Metabase Feature

Birthday commands use Metabase, not a Bot-Jolyne public endpoint.

| Path | Purpose |
| --- | --- |
| `src/services/metabase.ts` | Metabase login/query helpers. |
| `src/commands/birthday.ts` | Birthday list command. |
| `src/commands/birthday-now.ts` | Birthday today command/test command. |
| `src/schedulers/birthday-now.ts` | Daily scheduled birthday announcement. |

Important env:

```text
METABASE_URL=https://metabase.kyou.id/
METABASE_EMAIL=...
METABASE_PASSWORD=...
METABASE_DATABASE_ID=2
BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID=...
```

## Optional Deliveree Web Monitor

Path:

```text
src/deliveree/webMonitor.ts
```

This is separate from the Chrome extension intake. It uses Playwright through:

```text
src/deliveree/webClient.ts
```

It is currently optional/guarded and not required for extension-based Auto Retry or Discord notifications.

Related files:

| Path | Purpose |
| --- | --- |
| `src/deliveree-login.ts` | Manual Playwright login helper. |
| `src/deliveree/webClient.ts` | Browser/session interaction. |
| `src/deliveree/webMonitor.ts` | Periodic web monitor loop. |
| `src/deliveree/webClassifier.ts` | Text classifier for Deliveree page states. |
| `src/deliveree/webSafety.ts` | Safety checks around web actions. |

## Security Layer

| Path | Purpose |
| --- | --- |
| `src/security/discordAccess.ts` | Restricts Deliveree commands to allowed guild/channel/user contexts. |
| `src/security/signedButton.ts` | Signing/verification utilities for Discord button IDs. |
| `src/security/buttonReplayGuard.ts` | Prevents replay of signed button nonces. |

## Tests

Important test files:

| Path | Coverage |
| --- | --- |
| `src/deliveree/extensionContentScript.test.ts` | Content script page-state detection and homepage active order detection. |
| `src/deliveree/extensionDomExtractor.test.ts` | HTML fixture parsing and payload extraction. |
| `src/deliveree/extensionIntake.test.ts` | Intake auth, page-state, event dedupe, retry notifications, Discord REST. |
| `src/deliveree/caseStore.test.ts` | Case persistence and action log updates. |
| `src/deliveree/webClassifier.test.ts` | Text classifier behavior. |
| `src/security/*.test.ts` | Discord access and signed button safety. |
| `src/kyouScannerPartnerExtension.test.ts` | Kyou Scanner Partner behavior. |

Run all tests:

```text
npm test
```

## Deployment Notes

### Build and Run

```text
npm run build
npm start
```

### Docker/Coolify

`Dockerfile` builds TypeScript and runs:

```text
npm start
```

For Deliveree extension remote intake, set at minimum:

```env
DELIVEREE_EXTENSION_ENABLED=true
DELIVEREE_EXTENSION_HOST=0.0.0.0
DELIVEREE_EXTENSION_PORT=3001
DELIVEREE_EXTENSION_TOKEN=<shared-extension-token>
DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS=yugi-browser,cindy-browser,rendy-browser
DELIVEREE_INTAKE_DISCORD_ENABLED=true
DELIVEREE_ALERT_CHANNEL_ID=<discord-channel-id>
DELIVEREE_ALLOWED_CHANNEL_IDS=<discord-channel-id>
DELIVEREE_ALLOWED_GUILD_ID=<discord-guild-id>
```

The extension popup must use the public intake endpoint once infrastructure provides it.

Local test endpoint:

```text
http://127.0.0.1:3001
```

Remote production endpoint example:

```text
https://deliveree-intake.kyou.id
```

## End-to-End Deliveree Extension Flow

```text
Chrome extension content script
→ detects booking/status/retry/driver state
→ sends message to extension background script
→ background script POSTs to intake server
→ intake validates token and device ID
→ intake stores/updates recovery case
→ intake sends Discord embed
→ Discord slash commands read memory or stored case file
```

Auto Retry click flow is local:

```text
Chrome page DOM
→ extension detects no-driver modal
→ extension waits 8–15 seconds
→ extension clicks visible `Coba Pesan Kembali`
```

Remote endpoint is required for Discord visibility, but not required for the local click itself.
