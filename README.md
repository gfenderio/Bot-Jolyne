# Bot Jolyne

Bot Discord berbasis Node.js + TypeScript untuk operasional Kyou. Fokus aktif repo ini:

- Birthday reminder dari Metabase.
- Kyou Item Scanner Extension.
- Kyou Deliveree Partner Extension untuk membaca status halaman Deliveree, mengirim notifikasi Discord, dan Auto Retry driver dari Chrome user yang sedang login.

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Untuk development:

```bash
npm run dev
```

Deploy slash command:

```bash
npm run commands:deploy
```

## Environment Penting

Isi env ini di Coolify untuk bot + Deliveree remote intake:

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
METABASE_URL=
METABASE_EMAIL=
METABASE_PASSWORD=
METABASE_DATABASE_ID=2
BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID=

DELIVEREE_EXTENSION_ENABLED=true
DELIVEREE_EXTENSION_HOST=0.0.0.0
DELIVEREE_EXTENSION_PORT=3001
DELIVEREE_EXTENSION_TOKEN=
DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS=yugi-browser,cindy-browser,rendy-browser
DELIVEREE_INTAKE_DISCORD_ENABLED=true
DELIVEREE_ALERT_CHANNEL_ID=1501899831268868106
DELIVEREE_ALLOWED_CHANNEL_IDS=1501899831268868106
DELIVEREE_ALLOWED_GUILD_ID=728199543249829909
DELIVEREE_CASE_STORE_PATH=data/deliveree-cases.json
```

Endpoint remote extension saat ini:

```text
http://w9a2iwiolpi9wvw2fx6wlboo.43.134.34.13.sslip.io
```

## Slash Commands

- `/ping`: cek latency bot.
- `/server`: tampilkan info server Discord.
- `/birthday`: ambil daftar birthday admin dari Metabase.
- `/birthdaynow`: tampilkan admin yang birthday hari ini.
- `/whoami`: tampilkan Discord user ID untuk konfigurasi.
- `/deliveree-status`: cek status Deliveree terakhir dari extension.
- `/deliveree-extension-health`: cek device extension yang aktif dan recovery case.
- `/deliveree-cases`: lihat daftar case Deliveree terbaru.
- `/deliveree-case`: lihat detail satu case Deliveree.

## Kyou Deliveree Partner Extension

Extension berjalan di Chrome staff yang sudah login `https://webapp.deliveree.com`. Data dikirim ke remote intake, lalu bot mengirim embed ke Discord.

Fitur aktif:

- Membaca order aktif dari halaman detail booking dan top navigation/homepage Deliveree.
- Mengirim notifikasi saat order baru terbaca.
- Mengirim notifikasi saat status mencari driver/gagal driver terbaca.
- Auto Retry menekan tombol `Coba Pesan Kembali` jika fitur di popup aktif.
- Mengirim notifikasi setiap retry, termasuk attempt, delay, dan durasi.
- Mengirim notifikasi saat driver ditemukan, termasuk driver/plat jika terbaca.
- Menyimpan riwayat aktivitas lokal di popup untuk troubleshooting.

Data yang dikirim dibatasi untuk kebutuhan operasional: event, booking ID, status, URL halaman, jenis layanan, jarak, jumlah tujuan, No. Job, driver, plat, ETA/keterlambatan jika terlihat. Extension tidak mengirim cookie, password, OTP, foto, signature, atau data pembayaran.

### Pack Extension

```bash
npm run deliveree:extension:pack
```

Folder hasil pack:

```text
dist/deliveree-capture-extension
```

Cara pasang di komputer user:

1. Buka `chrome://extensions`.
2. Aktifkan `Developer mode`.
3. Klik `Load unpacked`.
4. Pilih `dist/deliveree-capture-extension`.
5. Buka popup extension.
6. Pastikan `Intake URL` berisi endpoint remote.
7. Isi `Device ID` salah satu: `yugi-browser`, `cindy-browser`, atau `rendy-browser`.
8. Isi `Token` sesuai `DELIVEREE_EXTENSION_TOKEN` di server.
9. Klik `Simpan`, lalu `Test > Test Intake`.
10. Cek Discord dengan `/deliveree-status` atau `/deliveree-extension-health`.

## Kyou Item Scanner Extension

Extension `Kyou Item Scanner Opener` dipakai untuk scanner keyboard-wedge. Saat scanner membaca kode angka lalu mengirim `Enter`, tab aktif redirect ke halaman item Kyou.

Default:

- Kode contoh: `219402`
- URL tujuan: `https://kyou.id/items/219402`
- Host aktif: `https://kyou.id/*` dan `https://old.kyou.id/*`
- Mode default: redirect tab aktif.

Pack:

```bash
npm run kyou:scanner-extension:pack
```

## Struktur

```text
src/
  commands/      Slash commands Discord
  config/        Validasi environment
  deliveree/     Intake, parser, case store, Discord notifier
  events/        Event Discord
  services/      Integrasi eksternal dan registrasi slash command
  types/         Shared TypeScript types
extensions/
  deliveree-capture/          Chrome extension Deliveree remote intake
  kyou-item-scanner-opener/   Chrome extension scanner Kyou
scripts/
  pack-deliveree-extension.js
  pack-kyou-scanner-extension.js
```
