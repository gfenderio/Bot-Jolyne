# Bot Jolyne

Internal Discord bot for Kyou operations. Node.js + TypeScript + discord.js.

Jolyne is the layer between the systems the team already runs — the admin panel, the warehouse PDA, spreadsheets, Metabase, Notion — and Discord, where the work actually gets coordinated. It watches for things that are stuck, asks the people who can fix them, and records the answers.

## What it does

- **Fulfillment** — flags orders whose items are stuck in picking, asks staff why (still queued / damaged / can't find it) straight from Discord, and keeps a daily recap of orders that have gone stale.
- **Warehouse** — receives photo proofs and item batches from the PDA and the arrival check-in flow, and reports them to the right channel.
- **Deliveree** — a browser extension that watches driver-booking pages, notifies Discord, and retries a booking when no driver is found.
- **Team** — birthday reminders, part-timer attendance, live-session logging, and daily standup notes into Notion.

Slash commands: `/ping`, `/server`, `/whoami`, `/birthday`, `/birthdaynow`, `/baito`, `/opname`, `/live`, `/live-recap`, `/task`, and the `/deliveree-*` family.

## Running it

```bash
npm install
cp .env.example .env   # fill in credentials
npm run build
npm start
```

Development: `npm run dev` · Register slash commands: `npm run commands:deploy`

Deployment is manual — pushing does not release.

## Layout

```text
src/
  commands/     Slash commands
  config/       Env validation
  events/       Discord interaction router
  handlers/     Interactive flows
  schedulers/   Crons and pollers
  machitan/     HTTP intake from the warehouse PDA
  services/     External integrations and local stores
extensions/     Chrome extensions
```

Per-file detail: [`CODE_STRUCTURE.md`](CODE_STRUCTURE.md). Configuration keys: `.env.example`.
