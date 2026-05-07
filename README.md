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

Mockup Deliveree berjalan otomatis saat `npm run dev` atau `npm start`. Poller memantau order aktif yang dibuat lewat `/mock-order`, mengambil status dari `MockDelivereeClient`, menyimpan status terakhir di memori, lalu mengirim alert hanya saat ada recovery event atau status akhir.

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

## Demo Mock Order 1-10

Gunakan `/mock-order slot` untuk membuat booking ID demo dari slot 1 sampai 10. Slot akan menjadi booking ID `MOCK-001` sampai `MOCK-010`, reset dari awal setiap command dipanggil ulang, lalu otomatis masuk daftar pantau poller.

Contoh cepat:

- `/mock-order 1`: order normal berhasil sampai `completed`.
- `/mock-order 2`: order `cancelled`, cocok untuk demo keputusan reorder.
- `/mock-order 4`: driver stuck sampai alert `warning` dan `critical`.
- `/confirm-reorder`: gunakan setelah alert cancelled jika command recovery ini tersedia di deployment kamu.
- `/replace-deliveree`: gunakan untuk mencatat order pengganti jika command recovery ini tersedia di deployment kamu.

Mapping skenario:

```text
1  normal_completed
2  cancelled
3  stuck_driver_warning
4  stuck_driver_critical
5  normal_completed
6  repeated_cancel
7  cancelled
8  normal_completed
9  stuck_driver_warning
10 stuck_driver_critical
```

Timeline demo dibuat cepat:

- `normal_completed`: 0s searching driver, 5s driver assigned, 10s arrived pickup, 15s on delivery, 25s completed.
- `cancelled`: 0s searching driver, 5s driver assigned, 12s cancelled.
- `stuck_driver_warning`: 0s searching driver, 5s driver assigned, warning setelah 20 detik tanpa progress.
- `stuck_driver_critical`: 0s searching driver, 5s driver assigned, warning setelah 20 detik dan critical setelah 40 detik.
- `repeated_cancel`: simulasi cancelled untuk retry/replacement flow.

## Slash Commands

- `/ping`: cek latency bot.
- `/server`: tampilkan info server Discord.
- `/birthday`: ambil daftar birthday admin dari Metabase.
- `/birthdaynow`: tampilkan admin yang birthday hari ini.
- `/birthdaynowtest`: tes tampilan embed birthday tanpa data Metabase.
- `/track-test`: tes tracking Deliveree dari mock data lokal. Opsi `booking_id` bisa diisi, default `19320032`.
- `/mock-order`: buat mock order Deliveree slot 1-10 untuk demo recovery.

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
