# Bot Jolyne

> Stand-nya Jolyne Cujoh, **Stone Free**, mengurai tubuhnya sendiri jadi benang — lalu memakai benang itu untuk mengikat apa pun yang terpisah jadi satu.
>
> Bot ini kurang lebih begitu: satu proses Node yang mengulur benang ke mana-mana — kyou.id, PDA machitan, Google Sheet, Metabase, Notion — lalu menariknya semua ke **Discord**, tempat tim gudang & admin sebenarnya bekerja. Tidak ada satu pun fitur di sini yang "punya"-nya sendiri; semuanya menyambungkan sistem yang sudah ada.

Node.js + TypeScript + discord.js. Deploy manual lewat Coolify (**tidak ada CI/CD** — push tidak otomatis rilis).

## Fitur

### Fulfillment — barang & order nyangkut
- **Triase PICK 24 jam** (`schedulers/pick-triage.ts`) — poller tiap 15 menit ke Metabase. Order yang sudah di-print tapi barangnya belum di-pick selama 24 jam dikirim ke Discord: **satu pesan per order** (embed berisi daftar barangnya) + dropdown 3 opsi — ⏳ masih antri pick · ⚠️ barang rusak · ❓ belum ketemu. Pilih → modal deskripsi → bot balas embed hasil (siapa lapor, status, keterangan), lalu pesan pertanyaannya dihapus. Opsi "barang rusak" bisa dilampiri foto (opsional). Band 24–30 jam; yang lebih lama itu ranah digest di bawah.
- **Digest order nyangkut 3–30 hari** (`schedulers/fulfillment-stale.ts`) — rekap harian 09:00 WIB, level order, dikelompokkan per tahap (PRINT → PICK → PACK → RESI). Read-only, tanpa tombol. Logika tahapnya sengaja identik dengan `App\Support\FulfillmentStale` di kyou.id — **kalau salah satu diubah, samakan yang lain.**

### Gudang — jembatan dari PDA machitan
Server HTTP kecil (`machitan/httpServer.ts`) yang menerima kiriman dari PDA/aplikasi lain, semua dipagari Bearer token:
- `POST /machitan/pick-proof` — foto bukti barang di-pick.
- `POST /machitan/pickup-proof` — foto bukti paket pickup diterima di toko.
- `POST /machitan/ws-inbox` — item WS masuk; ada laporan harian + rekap opname.
- `/machitan/absen/*` — **Absen Arrival**: batch barang datang dikirim dari Sheet jurnal, dicocokkan di gudang, hasilnya diekspor jadi file Excel (RES/CONV/Ledger/Absen) ke Discord.
- `GET /health` — cek hidup.

### Deliveree
Chrome extension yang berjalan di browser staf yang sudah login `webapp.deliveree.com`: membaca order & status driver dari halaman, mengirim notifikasi ke Discord, dan **Auto Retry** menekan "Coba Pesan Kembali" saat driver tidak ditemukan. Kirim notifikasi tiap retry (attempt, delay, durasi) dan saat driver akhirnya dapat.

### Lain-lain
- **Birthday admin** — pengingat harian dari Metabase.
- **Oripa Live** — `/live start`/`/live end` (selfie proof + foto insight) dan `/live-recap`.
- **Absen baito** — tombol clock-in/out untuk staf paruh waktu.
- **Standup Notion** — laporan harian di-upsert ke Work Journal.
- **Kyou Item Scanner** — extension buat scanner keyboard-wedge: scan barcode → tab langsung buka halaman item di kyou.id.

## Slash Commands

| Command | Fungsi |
| --- | --- |
| `/ping`, `/server`, `/whoami` | Utilitas (latency, info server, Discord user ID) |
| `/birthday`, `/birthdaynow` | Ulang tahun admin |
| `/baito` | Absen masuk/pulang staf paruh waktu |
| `/opname` | Rekap opname WS |
| `/live start`, `/live end`, `/live-recap` | Sesi live Oripa |
| `/task` | Bikin task Notion |
| `/deliveree-status`, `/deliveree-cases`, `/deliveree-case`, `/deliveree-extension-health` | Deliveree |

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Development: `npm run dev` · Daftarkan slash command: `npm run commands:deploy`

## Konfigurasi

Env inti (selebihnya lihat `.env.example`):

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
METABASE_URL=
METABASE_EMAIL=
METABASE_PASSWORD=
METABASE_DATABASE_ID=2
```

> **Setelan fulfillment (triase PICK + digest) TIDAK diambil dari env server.** Channel & flag-nya dipaksa dari kode di `src/config/env.ts` (pola sama `BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID`), supaya ganti setelan tidak perlu utak-atik env Coolify. Mau ubah → edit file itu lalu redeploy.

Dua hal yang gampang menjatuhkan bot, catat baik-baik:

- **Intent `MessageContent` (privileged)** dipakai fitur foto barang rusak. Kalau intent itu dimatikan di Developer Portal, Discord **menolak login dan seluruh bot mati** — bukan cuma fitur fotonya. Pemulihan: set `PICK_TRIAGE_PHOTO_ENABLED` jadi `"false"` di `src/config/env.ts`.
- **`data/` tidak dipasangi volume.** Store (`pick-triage.json`, `deliveree-cases.json`, dll) hilang tiap redeploy. Itu keputusan sadar — konsekuensinya barang di band 24–30 jam bisa terkirim ulang setelah redeploy.

## Pasang Chrome Extension

```bash
npm run deliveree:extension:pack      # → dist/deliveree-capture-extension
npm run kyou:scanner-extension:pack   # → dist/kyou-item-scanner-extension
```

Di komputer staf: `chrome://extensions` → aktifkan **Developer mode** → **Load unpacked** → pilih folder hasil pack. Khusus Deliveree, buka popup-nya lalu isi **Intake URL** (endpoint remote di bawah), **Device ID** (`yugi-browser` / `cindy-browser` / `rendy-browser`), dan **Token** sesuai `DELIVEREE_EXTENSION_TOKEN` di server → `Simpan` → `Test Intake` → cek dengan `/deliveree-status`.

```text
http://w9a2iwiolpi9wvw2fx6wlboo.43.134.34.13.sslip.io
```

Data yang dikirim extension dibatasi ke kebutuhan operasional (event, booking ID, status, URL, layanan, jarak, No. Job, driver, plat, ETA). **Tidak** mengirim cookie, password, OTP, foto, tanda tangan, atau data pembayaran.

## Struktur

```text
src/
  commands/     Slash commands
  config/       Validasi env (+ setelan yang dipaksa dari kode)
  events/       Router interaksi Discord (dropdown, modal, tombol)
  handlers/     Alur interaktif (triase PICK, absen baito, oripa live)
  schedulers/   Cron & poller (triase PICK, digest fulfillment, birthday, dll)
  machitan/     Server HTTP intake dari PDA (proof, WS inbox, absen)
  services/     Metabase, Notion, store JSON
extensions/     Chrome extension (Deliveree, item scanner)
scripts/        Pack extension, pembersih channel triase, dll
```

Detail per file: lihat [`CODE_STRUCTURE.md`](CODE_STRUCTURE.md).
