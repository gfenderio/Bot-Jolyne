# Bot Jolyne

Bot Jolyne berbasis Node.js dan TypeScript. Fokus Deliveree saat ini adalah MVP Chrome extension lokal yang read-only untuk membaca status halaman Deliveree dan mengirim sinyal minimal ke intake lokal Jolyne.

## Setup

1. Install dependency:

```bash
npm install
```

2. Salin `.env.example` menjadi `.env`.

   Untuk intake extension lokal, isi `DELIVEREE_EXTENSION_TOKEN` dan biarkan `DELIVEREE_INTAKE_DISCORD_ENABLED=false` jika hanya ingin test lokal tanpa kirim Discord. Isi `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, dan `DISCORD_GUILD_ID` jika ingin menjalankan Discord bot/slash command.

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

## Mockup Deliveree Legacy

Mockup Deliveree masih ada untuk unit test dan referensi development lama, tapi command `/mock-order` dan `/track-test` tidak diregister di runtime aktif. Fokus MVP sekarang adalah Chrome extension lokal. Poller mock membaca order yang dimasukkan ke mock runtime, mengambil status dari `MockDelivereeClient`, menyimpan status terakhir di memori, lalu mengirim alert hanya saat ada recovery event atau status akhir.

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

## Demo Mock Order Legacy

Slot demo lama tersedia di kode mock dari slot 1 sampai 10. Slot akan menjadi booking ID `MOCK-001` sampai `MOCK-010`, reset dari awal setiap command dipanggil ulang, lalu otomatis masuk daftar pantau poller.

Contoh cepat:

- Slot 1: order normal berhasil sampai `completed`.
- Slot 2: order `cancelled`, cocok untuk demo keputusan reorder.
- Slot 4: driver stuck sampai alert `warning` dan `critical`.

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
- `/whoami`: tampilkan Discord user ID untuk konfigurasi owner bot.
- `/deliveree-status`: cek status halaman Deliveree terakhir dari Chrome extension lokal.

## Deliveree Web Monitor Aman

Deliveree web monitor memakai Playwright untuk membaca halaman Deliveree terautentikasi tanpa memakai API resmi. Karena syarat penggunaan Deliveree membatasi penggunaan program/script untuk mengambil data dari platform tanpa otorisasi, fitur live web automation dikunci oleh compliance gate.

Gunakan fitur ini hanya setelah ada approval yang jelas, misalnya API resmi/webhook, izin tertulis dari Deliveree/account manager, atau approval internal yang menyatakan akses otomatis ini diperbolehkan. Sebelum itu, gunakan mock flow, screen recording, atau fixture screenshot untuk discovery dan testing.

Referensi: https://www.deliveree.com/id/en/terms-and-conditions-for-users/

Konfigurasi utama:

```bash
DELIVEREE_ALERT_CHANNEL_ID=1501899831268868106
DELIVEREE_ALLOWED_CHANNEL_IDS=1501899831268868106
DELIVEREE_OWNER_USER_IDS=your_discord_user_id
DELIVEREE_ACTION_MODE=paused
DELIVEREE_WEB_AUTOMATION_APPROVED=false
DELIVEREE_WATCH_URLS=
DELIVEREE_BUTTON_SIGNING_SECRET=change-me-to-random-secret
DELIVEREE_CASE_STORE_PATH=data/deliveree-cases.json
DELIVEREE_MONITOR_INTERVAL_SECONDS=180
DELIVEREE_PLAYWRIGHT_PROFILE_DIR=data/deliveree-playwright-profile
DELIVEREE_SCREENSHOT_DIR=data/deliveree-screenshots
```

Security boundary:

- Jangan aktifkan `DELIVEREE_WEB_AUTOMATION_APPROVED=true` sebelum approval/izin akses otomatis jelas.
- Prioritaskan API resmi/webhook Deliveree jika tersedia untuk use case perusahaan.
- Jangan simpan email/password Deliveree di repo, README, `.env.example`, database, atau log.
- Login Deliveree dilakukan manual lewat browser Playwright.
- Jika credential pernah diketik di chat, rotasi password sebelum dipakai live.
- Action Deliveree hanya boleh dijalankan oleh Discord user ID di `DELIVEREE_OWNER_USER_IDS`.
- Bot tidak boleh klik tombol final seperti `Pesan Pengemudi`, `Simpan`, `Batalkan & Simpan`, atau `Konfirmasi`.
- Jika UI tidak dikenali, captcha muncul, atau session expired, bot mengembalikan status aman dan meminta review manual.
- Untuk discovery sebelum approval, gunakan screen recording dari pengguna internal dan sanitized screenshot/test fixture, bukan live polling.

Login manual lokal:

```bash
npm run deliveree:login
```

Command ini membuka browser Playwright dengan persistent profile di `DELIVEREE_PLAYWRIGHT_PROFILE_DIR`. Login di browser tersebut, lalu tekan Enter di terminal setelah selesai. Untuk Coolify, pastikan folder `data/` dipasang sebagai persistent volume agar session dan case store tidak hilang saat restart.

## Deliveree Extension Lokal

Tahap MVP Deliveree memakai Chrome extension lokal yang read-only. Extension berjalan di browser staff yang sudah login Deliveree, membaca detail aman dari halaman order aktif, lalu hanya mengirim sinyal penting ke endpoint lokal Jolyne. Intake-only runner bisa mengirim notifikasi ke `DELIVEREE_ALERT_CHANNEL_ID` lewat Discord REST tanpa login Discord gateway, sehingga tidak mengganggu Jolyne yang sedang berjalan di Coolify.

Konfigurasi `.env` lokal:

```bash
DELIVEREE_EXTENSION_ENABLED=true
DELIVEREE_EXTENSION_PORT=3001
DELIVEREE_EXTENSION_TOKEN=change-me-local-random-token
DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS=yugi-browser
DELIVEREE_INTAKE_DISCORD_ENABLED=false
DELIVEREE_ALERT_CHANNEL_ID=1501899831268868106
```

Cara pakai:

1. Build TypeScript:

```bash
npm run build
```

2. Jalankan intake lokal saja:

```bash
npm run deliveree:intake
```

3. Untuk membuat folder extension yang siap di-load:

```bash
npm run deliveree:extension:pack
```

4. Buka `chrome://extensions`, aktifkan Developer mode, lalu pilih `Load unpacked`.
5. Pilih folder `dist/deliveree-capture-extension`. Untuk development langsung, folder `extensions/deliveree-capture` juga bisa dipakai.
6. Buka popup extension, isi:
   - Intake URL: `http://127.0.0.1:3001`
   - Device ID: `yugi-browser`
   - Token: sama dengan `DELIVEREE_EXTENSION_TOKEN`
7. Buka halaman `https://webapp.deliveree.com/bookings/<id>`.

Data yang dikirim sengaja minimal: event MVP, booking ID, status, URL halaman, reason gagal bila terbaca, jenis layanan, jarak, jumlah tujuan, dan No. Job. Extension tidak mengirim nomor telepon, alamat lengkap, foto, signature, cookie, password, OTP, atau data pembayaran. Extension juga tidak klik tombol Deliveree apa pun.

Halaman utama `https://webapp.deliveree.com/bookings/new` dan draft pemesanan seperti `https://webapp.deliveree.com/bookings/new?ftl=true` dicatat sebagai log lokal saja. Kartu `Pesanan Terbaru` di halaman utama tidak dianggap sebagai booking aktif, sehingga tidak memicu alert Discord.

Popup extension menyimpan log lokal terbatas untuk troubleshooting. Gunakan tombol `Copy` untuk menyalin log terbaru saat perlu review bersama, atau `Clear` untuk mengosongkan log setelah issue selesai. Log tidak menyimpan token, cookie, password, OTP, nomor telepon, alamat lengkap, foto, atau signature.

Gunakan `Test Intake` di popup untuk mengecek apakah endpoint lokal Jolyne hidup, token/device ID diterima, dan halaman Deliveree aktif bisa dibaca. Tombol ini sekaligus berfungsi seperti test lokal `/deliveree-status` dari sisi extension. Gunakan `Send Discord Test` hanya saat `DELIVEREE_INTAKE_DISCORD_ENABLED=true`; jika flag masih `false`, intake akan mengembalikan status `discord_test_disabled`.

Command test lokal:

- `/deliveree-status`: membaca heartbeat terakhir dari Chrome extension dan mengirim embed ringkas.
- Jika Deliveree belum terbuka atau heartbeat sudah stale, Jolyne akan menampilkan bahwa halaman Deliveree belum terdeteksi.
- Jika Deliveree terbuka di front page atau draft pemesanan, Jolyne menampilkan status idle.
- Jika booking sedang mencari driver, Jolyne menampilkan durasi status berdasarkan pertama kali status itu terlihat.
- Jika driver sudah berjalan, Jolyne bisa membaca state operasional seperti `going_to_pickup`, `waiting_pickup`, `going_to_destination`, `arrived_destination`, ETA, keterlambatan, driver, dan plat jika terlihat.
- Jika order gagal karena no driver atau cancelled, Jolyne menampilkan status gagal/cancelled dan reason bila terbaca.

Rule notifikasi tahap 1:

- `order_created`: booking ID asli sudah muncul dan status aktif awal terbaca, seperti `searching_driver` atau `driver_assigned`.
- `order_failed`: booking ID asli sudah muncul dan status gagal terbaca, seperti `cancelled` atau `no_driver_found`.
- Status normal lain seperti `going_to_pickup`, `going_to_destination`, `arrived_destination`, `completed`, `unknown`, dan halaman draft hanya masuk log/status lokal.
- Heartbeat page-state yang sama didedup di log server agar runner tidak berisik.
- Manual `Test Intake` tetap muncul di log popup/server supaya debugging jelas.
- Event booking dan status yang sama berulang disimpan sebagai observasi, tapi tidak mengirim spam Discord.

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
extensions/
  deliveree-capture/  Chrome extension read-only untuk endpoint lokal
```
