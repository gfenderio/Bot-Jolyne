# Bot Jolyne

Template Discord bot TypeScript dengan `discord.js` v14.

## Setup

1. Install dependency:

```bash
npm install
```

2. Salin `.env.example` menjadi `.env`, lalu isi token dan ID Discord.

3. Jalankan mode development:

```bash
npm run dev
```

Bot akan register slash command ke `DISCORD_GUILD_ID` sebelum login. Kalau hanya ingin deploy command tanpa menjalankan bot:

```bash
npm run commands:deploy
```

## Struktur

```text
src/
  commands/      Slash commands
  config/        Validasi environment
  events/        Event Discord
  types/         Shared TypeScript types
  deploy-commands.ts
  index.ts
```
