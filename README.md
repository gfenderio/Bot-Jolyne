# Bot Jolyne

Bot Jolyne berbasis Node.js dan TypeScript. Saat ini repo berisi Discord bot existing dan mockup awal pemantauan status order Deliveree via Discord webhook.

## Setup

1. Install dependency:

```bash
npm install
```

2. Salin `.env.example` menjadi `.env`.

   Untuk mockup Deliveree lokal, `DISCORD_WEBHOOK_URL` boleh dikosongkan supaya update ditulis ke console. Isi `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, dan `DISCORD_GUILD_ID` jika ingin menjalankan Discord bot/slash command.

3. Jalankan mode development:

```bash
npm run dev
```

Bot akan register slash command ke `DISCORD_GUILD_ID` sebelum login. Kalau hanya ingin deploy command tanpa menjalankan bot:

```bash
npm run commands:deploy
```

4. Build TypeScript:

```bash
npm run build
```

5. Jalankan hasil build:

```bash
npm start
```

## Mockup Deliveree

Mockup Deliveree berjalan otomatis saat `npm run dev` atau `npm start`. Poller memakai booking ID contoh dari `src/deliveree/mockData.ts`, mengambil status dari `MockDelivereeClient`, menyimpan status terakhir di memori, lalu mengirim update hanya saat status berubah.

Status mock yang tersedia:

- `searching_driver`
- `driver_assigned`
- `arrived_at_pickup`
- `on_delivery`
- `near_destination`
- `completed`
- `cancelled`

Format pesan:

```text
[Jolyne] Update Deliveree #19320032
Status: Driver Assigned
Driver: Budi
Plat: B 1234 XYZ
ETA: 14:30
```

Jika `DISCORD_WEBHOOK_URL` diisi, pesan dikirim ke Discord webhook. Jika kosong, pesan yang sama ditampilkan ke console agar mockup tetap bisa dites lokal tanpa koneksi Discord.

## Slash Commands

- `/ping`: cek latency bot.
- `/server`: tampilkan info server Discord.
- `/birthday`: ambil daftar birthday admin dari Metabase.
- `/birthdaynow`: tampilkan admin yang birthday hari ini.
- `/birthdaynowtest`: tes tampilan embed birthday tanpa data Metabase.
- `/track-test`: tes tracking Deliveree dari mock data lokal. Opsi `booking_id` bisa diisi, default `19320032`.

## Struktur

```text
src/
  commands/      Slash commands
  config/        Validasi environment
  deliveree/     Mock client, mapper status, notifier, state store, poller
  events/        Event Discord
  services/      Integrasi eksternal dan registrasi slash command
  types/         Shared TypeScript types
  deploy-commands.ts
  index.ts
```
