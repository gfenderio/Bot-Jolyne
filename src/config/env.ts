import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  },
  z.string().optional()
);

const optionalUrl = optionalString.pipe(z.string().url().optional());

const optionalDatabaseId = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed === "" ? 2 : trimmed;
    }

    return value === undefined ? 2 : value;
  },
  z.coerce.number().int().positive()
);

const pollIntervalSeconds = z.preprocess(
  (value) => {
    if (value === undefined) {
      return 10;
    }

    if (typeof value === "string" && value.trim() === "") {
      return 10;
    }

    return value;
  },
  z.coerce.number().int().positive()
);

const localPort = z.preprocess(
  (value) => {
    if (value === undefined) {
      return 3001;
    }

    if (typeof value === "string" && value.trim() === "") {
      return 3001;
    }

    return value;
  },
  z.coerce.number().int().min(1).max(65535)
);

const optionalStringList = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  },
  z.array(z.string()).optional()
);

const optionalBoolean = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value === undefined ? false : value;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }

  if (["", "0", "false", "no", "n"].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean().default(false));

const delivereeActionMode = z.enum(["paused", "prepare_reorder", "readonly"]).default("readonly");

const envSchema = z.object({
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,
  DISCORD_WEBHOOK_URL: optionalUrl,
  POLL_INTERVAL_SECONDS: pollIntervalSeconds,
  METABASE_URL: optionalUrl,
  METABASE_EMAIL: optionalString.pipe(z.string().email().optional()),
  METABASE_PASSWORD: optionalString,
  METABASE_DATABASE_ID: optionalDatabaseId,
  BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID: optionalString.default("1500736344182358066"),
  DELIVEREE_ACTION_MODE: delivereeActionMode,
  DELIVEREE_ALERT_CHANNEL_ID: optionalString.default("1501899831268868106"),
  DELIVEREE_ALLOWED_CHANNEL_IDS: optionalStringList,
  DELIVEREE_ALLOWED_GUILD_ID: optionalString,
  DELIVEREE_BUTTON_SIGNING_SECRET: optionalString,
  DELIVEREE_CASE_STORE_PATH: optionalString.default("data/deliveree-cases.json"),
  MACHITAN_PICK_PROOF_CHANNEL_ID: optionalString.default("1418827227264450663"),
  MACHITAN_ECOMMERCE_PICK_REQUEST_CHANNEL_ID: optionalString.default("1501899831268868106"),
  MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_ENABLED: optionalBoolean,
  MACHITAN_ECOMMERCE_PICK_REQUEST_NOTIFY_EXISTING: optionalBoolean,
  MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_INTERVAL_SECONDS: pollIntervalSeconds.default(15),
  MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_LIMIT: pollIntervalSeconds.default(50),
  MACHITAN_ECOMMERCE_PICK_REQUEST_SEEN_STORE_PATH: optionalString.default("data/machitan-ecommerce-pick-requests-seen.json"),
  // Channel tujuan export Absen Arrival (RES/CONV xlsx). Default = channel machitan update.
  MACHITAN_ABSEN_CHANNEL_ID: optionalString.default("1501899831268868106"),
  // Bukti foto paket pickup toko diterima. Default di kode (bukan env server) —
  // pola sama seperti channel lain, supaya tak perlu utak-atik Coolify tiap deploy.
  MACHITAN_PICKUP_PROOF_CHANNEL_ID: optionalString.default("1501899831268868106"),
  MACHITAN_KYOU_API_BASE_URL: optionalString.default("https://api.kyou.id/api"),
  MACHITAN_KYOU_API_TOKEN: optionalString,
  // Token yang diterima intake Machitan (pick-proof, shipping, ws-inbox).
  // Default berisi token lama + baru selama masa rotasi; setelah semua PDA
  // update ke APK bertoken baru, set env ini ke token baru saja.
  MACHITAN_INTAKE_TOKENS: optionalStringList.default([
    "kyou-machitan-secret-2026",
    "1951f1b0273f41995232d32ff73f09c435a4b5dca71594b882307e9d2ea8e558",
  ]),
  DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS: optionalStringList.default(["yugi-browser"]),
  DELIVEREE_EXTENSION_ENABLED: optionalBoolean,
  DELIVEREE_EXTENSION_HOST: optionalString.default("0.0.0.0"),
  DELIVEREE_EXTENSION_PORT: localPort,
  DELIVEREE_EXTENSION_TOKEN: optionalString.pipe(
    z.string().min(32, "Token harus minimal 32 karakter untuk keamanan.").optional()
  ),
  DELIVEREE_INTAKE_DISCORD_ENABLED: optionalBoolean,
  DELIVEREE_MONITOR_INTERVAL_SECONDS: pollIntervalSeconds.default(60),
  DELIVEREE_OWNER_USER_IDS: optionalStringList.default(["419213146209779713"]),
  DELIVEREE_PLAYWRIGHT_PROFILE_DIR: optionalString.default("data/deliveree-playwright-profile"),
  DELIVEREE_SCREENSHOT_DIR: optionalString.default("data/deliveree-screenshots"),
  DELIVEREE_STUCK_DRIVER_WARNING_MINUTES: pollIntervalSeconds.default(20),
  DELIVEREE_STUCK_DRIVER_CRITICAL_MINUTES: pollIntervalSeconds.default(40),
  DELIVEREE_WEB_AUTOMATION_APPROVED: optionalBoolean,
  DELIVEREE_WATCH_URLS: optionalStringList.default([]),
  NOTION_TOKEN: optionalString,
  NOTION_TASK_DATABASE_ID: optionalString.default("285da332-9369-493d-9931-36c0905a9783"),
  NOTION_STANDUP_CHANNEL_ID: optionalString.default("1501899831268868106"),
  ORIPA_LIVE_CHANNEL_ID: optionalString.default("1501899831268868106"),
  ORIPA_LIVE_ALLOWED_USER_IDS: optionalStringList.default(["419213146209779713"]),
  ORIPA_LIVE_STORE_PATH: optionalString.default("data/oripa-live-sessions.json"),
  ORIPA_LIVE_RECAP_USER_IDS: optionalStringList.default(["419213146209779713"]),
  GEMINI_API_KEY: optionalString,
  BAITO_REXY_USER_ID: optionalString.default("593313231137931264"),
  BAITO_AZIS_USER_ID: optionalString.default("286790867329613824"),
  BAITO_ATTENDANCE_CHANNEL_ID: optionalString.default("1457554536934936769"),
  // Digest harian "order belum diproses > N hari" di fulfillment kyou.id.
  FULFILLMENT_STALE_ENABLED: optionalBoolean,
  // Kirim digest sekali langsung saat bot start (selain jadwal harian 09:00).
  // Berguna supaya hari pertama enable / setiap redeploy tidak ke-skip kalau
  // prosesnya baru hidup setelah lewat 09:00 WIB.
  FULFILLMENT_STALE_RUN_ON_START: optionalBoolean,
  FULFILLMENT_STALE_CHANNEL_ID: optionalString.default("1524977369641652227"),
  FULFILLMENT_STALE_THRESHOLD_DAYS: pollIntervalSeconds.default(3),
  // Batas atas: order lebih lama = abandoned, tidak masuk digest (samakan
  // dgn App\Support\FulfillmentStale::MAX_DAYS di kyou.id).
  FULFILLMENT_STALE_MAX_DAYS: pollIntervalSeconds.default(30),
  // Triase interaktif "PICK nyangkut >= N jam" (item-level). MVP Discord-only.
  PICK_TRIAGE_ENABLED: optionalBoolean,
  PICK_TRIAGE_CHANNEL_ID: optionalString.default("1524977369641652227"),
  // Channel HASIL (#☑️┃b2c-pending-shipment-confirmation): embed laporan dikirim
  // ke sini, terpisah dari channel pertanyaan di atas. Tim B2C cukup melihat
  // hasilnya, tidak perlu ikut melihat pertanyaan yang belum dijawab.
  // Kosongkan → hasil dikirim balik ke channel pertanyaan (perilaku lama).
  PICK_TRIAGE_RESULT_CHANNEL_ID: optionalString.default("1525411338191376464"),
  // Poller (bukan cron): tiap N menit cek, kirim barang begitu lewat MIN_HOURS.
  PICK_TRIAGE_POLL_MINUTES: pollIntervalSeconds.default(15),
  // Batas bawah usia nyangkut (jam) = ambang kirim. MAX_HOURS adalah PENGAMAN,
  // bukan filter bisnis: kalau store hilang (redeploy tanpa volume di data/),
  // tanpa batas atas bot akan memblast ulang seluruh backlog lama. Dengan poll
  // tiap 15 menit, band 24-30 jam tidak akan membuat barang kelewat.
  PICK_TRIAGE_MIN_HOURS: pollIntervalSeconds.default(24),
  PICK_TRIAGE_MAX_HOURS: pollIntervalSeconds.default(30),
  // Order yang pelunasannya ditagih lewat tombol "Early" di panel PO kyou.id
  // (admin_logs.action='early_order'): pembeli ditagih lunas SEBELUM barangnya
  // datang, ordernya di-print duluan supaya barangnya disiapkan. Jadi ambangnya
  // 4 hari, bukan 24 jam — barangnya sendiri mungkin memang belum sampai.
  PICK_TRIAGE_EARLY_MIN_HOURS: pollIntervalSeconds.default(96),
  // Orang yang di-mention tiap ada pesan triase baru — order biasa (24 jam)
  // maupun yang ditagih early (4 hari). Kosongkan → tidak ada mention sama sekali.
  PICK_TRIAGE_MENTION_USER_ID: optionalString.default("1337888111471886456"),
  // Maksimal barang yang diposting sekali jalan (sisanya diringkas).
  PICK_TRIAGE_MAX_ITEMS: pollIntervalSeconds.default(25),
  PICK_TRIAGE_STORE_PATH: optionalString.default("data/pick-triage.json"),
  // Auto-bersihkan: tiap putaran poll, order yang pesannya sudah nangkring tapi
  // ternyata SUDAH DI-PACK (atau barangnya sudah di-pick / statusnya berubah)
  // pesannya dihapus sendiri dari channel, tanpa nunggu staf menjawab dropdown.
  // Dipaksa "true" di bawah. Aman: order yang cuma "lewat 30 jam tapi masih
  // nyangkut" TIDAK dihapus — hanya yang benar-benar sudah maju tahapannya.
  PICK_TRIAGE_AUTOCLEAR_ENABLED: optionalBoolean,
  // Tampilkan kolom upload foto di modal saat opsi "Barang rusak" dipilih.
  // Dipaksa "true" di bawah. Tidak lagi menuntut intent privileged apa pun:
  // fotonya diunggah langsung di dalam modal, bukan lewat pesan di channel.
  PICK_TRIAGE_PHOTO_ENABLED: optionalBoolean,

  // "Kiriman terpisah — label gudang lain". Satu order bisa berisi barang dari
  // beberapa gudang di kota berbeda; tiap gudang mengirim paketnya sendiri dan
  // butuh label sendiri. Tapi kyou.id menandai "sudah dicetak" di level ORDER,
  // jadi begitu Bekasi mencetak, gudang lain kehilangan kotak centangnya.
  // Bot memantau catatan cetak di admin_logs lalu mengirim link cetak khusus
  // untuk TIAP gudang di order itu, Bekasi termasuk.
  SPLIT_PRINT_ENABLED: optionalBoolean,
  SPLIT_PRINT_CHANNEL_ID: optionalString.default("1523576053581349006"),
  SPLIT_PRINT_POLL_MINUTES: pollIntervalSeconds.default(15),
  SPLIT_PRINT_STORE_PATH: optionalString.default("data/split-print.json"),

  // Khusus pesan bagian BEKASI (pack group 1): yang ditagih head fulfillment,
  // bukan orang gudangnya. Kosongkan kalau tidak mau ada yang di-tag.
  SPLIT_PRINT_BEKASI_MENTION_USER_ID: optionalString.default("1337888111471886456"),

  // "Kiriman WSR". Staf toko memilih barang rotasi di PDA lalu menyiapkannya
  // sebagai kiriman — stoknya belum pindah. Gudang butuh daftar barangnya dalam
  // bentuk yang bisa dibawa keliling rak, jadi bot memantau tabel wsr_batches
  // dan mengirim Excel-nya ke channel. Stok baru berpindah saat kiriman itu
  // dieksekusi dari PDA.
  WSR_SHIPMENT_ENABLED: optionalBoolean,
  WSR_SHIPMENT_CHANNEL_ID: optionalString.default("1501899831268868106"),
  WSR_SHIPMENT_POLL_MINUTES: pollIntervalSeconds.default(5),
  WSR_SHIPMENT_STORE_PATH: optionalString.default("data/wsr-shipment.json"),
  // Specialist WH yang di-mention saat thread kiriman dibuka. Default = user
  // yang jadi assignee hampir semua tiket wh_wsr Mornye di purchasing_tickets
  // (dicek dari data prod). Kosongkan untuk mematikan mention.
  WSR_TICKET_MENTION_USER_ID: optionalString.default("1115194334497755157")
});

// Override dari kode agar mengabaikan setting environment server Coolify
process.env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID = "1500736344182358066";

// Triase PICK + digest fulfillment-stale: semua dipaksa dari kode supaya tidak
// perlu utak-atik env di Coolify tiap ganti setelan. Server masih menyimpan
// FULFILLMENT_STALE_CHANNEL_ID lama (channel bot-update) — override ini yang
// memindahkannya ke #pending-shipment.
process.env.FULFILLMENT_STALE_CHANNEL_ID = "1524977369641652227";
process.env.PICK_TRIAGE_CHANNEL_ID = "1524977369641652227";
process.env.PICK_TRIAGE_RESULT_CHANNEL_ID = "1525411338191376464";
process.env.PICK_TRIAGE_MENTION_USER_ID = "1337888111471886456";
process.env.PICK_TRIAGE_ENABLED = "true";
process.env.PICK_TRIAGE_PHOTO_ENABLED = "true";
process.env.PICK_TRIAGE_AUTOCLEAR_ENABLED = "true";

// Kiriman terpisah: channel BARU, khusus urusan cetak label gudang jauh —
// sengaja tidak digabung ke #pending-shipment supaya tidak tenggelam di antara
// laporan PICK (yang urusannya orang Bekasi).
process.env.SPLIT_PRINT_CHANNEL_ID = "1523576053581349006";
process.env.SPLIT_PRINT_BEKASI_MENTION_USER_ID = "1337888111471886456";
process.env.SPLIT_PRINT_ENABLED = "true";

// Kiriman WSR: menumpang channel machitan/pick-pack yang sudah dipakai laporan
// WS Inbox — penerimanya orang yang sama (gudang), jadi tidak perlu channel baru.
process.env.WSR_SHIPMENT_CHANNEL_ID = "1501899831268868106";
process.env.WSR_SHIPMENT_ENABLED = "true";
// Env mati yang mungkin masih tersisa di server; dibersihkan biar tidak
// menyesatkan kalau ada yang membaca konfigurasi Coolify.
delete process.env.PICK_TRIAGE_SINCE;
delete process.env.PICK_TRIAGE_RUN_ON_START;

export const env = envSchema.parse(process.env);

const requiredDiscordBotEnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1)
});

export function requireDiscordBotEnv() {
  const result = requiredDiscordBotEnvSchema.safeParse(env);

  if (!result.success) {
    throw new Error("DISCORD_TOKEN, DISCORD_CLIENT_ID, dan DISCORD_GUILD_ID wajib diisi untuk menjalankan Discord bot.");
  }

  return result.data;
}
