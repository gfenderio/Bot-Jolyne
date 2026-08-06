import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import { getOrInitWatermark, setWatermark, isPosted, markPosted } from "../services/splitPrintStore.js";
import { orderLink, printLabelUrl, printLabelClickUrl } from "../services/kyouLinks.js";
import { daftarKlik, geserMenit, JENDELA_KLIK_MENIT, type PrintClick } from "../services/splitPrintClickStore.js";

/**
 * "Kiriman terpisah — label gudang lain belum dicetak."
 *
 * MASALAHNYA. Satu order bisa berisi barang dari beberapa gudang di kota
 * berbeda (Bekasi / Tangerang / Surabaya), dan tiap gudang mengirim paketnya
 * sendiri — jadi butuh LABEL SENDIRI-SENDIRI. Tapi sistem kyou.id menandai
 * "sudah dicetak" di level ORDER, bukan per gudang: begitu Bekasi mencetak,
 * ordernya hilang dari tab Print dan gudang lain kehilangan kotak centangnya.
 * Data 45 hari: dari 120 order terpisah, 82 CUMA DICETAK SEKALI, dan yang
 * dicetak dua kali rata-rata telat 3,5 hari.
 *
 * CARA KERJANYA. Bot tidak bisa "melihat" tombol Print ditekan — dia cuma bisa
 * membaca database. Jejaknya ada di `admin_logs` (`print_order_address` /
 * `print_order_address_manual`). Jadi tiap N menit bot mencari catatan cetak
 * BARU, lalu memeriksa: order itu barangnya tersebar di lebih dari satu gudang?
 * Kalau ya → kirim satu pesan per gudang, berisi link cetak khusus gudang itu.
 *
 * GUDANG MANA YANG SUDAH CETAK — DUA SUMBER, SEJAK 6 AGU 2026.
 *
 * Yang PASTI: tautan cetak di pesan ini lewat `/print/<order>/<grup>` di server
 * bot dulu, jadi bot tahu gudang mana yang dibuka. Catatan cetak yang muncul di
 * jendela sesudah klik itu dihubungkan ke gudang tersebut. Kliknya sendiri
 * bukan bukti — lihat `splitPrintClickStore.ts`.
 *
 * Yang DITEBAK, dipakai untuk cetakan yang tidak lewat tautan bot (halaman
 * /admin) dan untuk seluruh catatan lama: `admin_logs` tidak menyimpan bagian
 * mana yang dicetak (halaman fulfillment mengirim `packGroupId`, tapi nilainya
 * tidak ikut ditulis ke `information`). Yang tersimpan: SIAPA yang mencetak.
 * Dan setiap admin punya lokasi kerja di
 * `users.office_location` (ALPHA / OMEGA / BETA / GAMMA / KCC) — isinya persis
 * nama source di `item_sources`, jadi lokasi itu bisa dipetakan ke pack group
 * lewat join biasa, tanpa daftar hardcode:
 *
 *   ALPHA, OMEGA → group 1 (Bekasi) · BETA, KCC → group 2 (Tangerang) ·
 *   GAMMA → group 3 (Surabaya)
 *
 * Orang gudang mencetak bagiannya sendiri, jadi "Savira (BETA) mencetak order
 * ini" = label Tangerang sudah keluar. Konsekuensinya: gudang yang sudah punya
 * pencetak TIDAK dikirimi pesan lagi, dan tag head fulfillment hanya keluar
 * kalau bagian Bekasi memang belum disentuh orang Bekasi.
 *
 * KENAPA INI PERLU. Sebelumnya semua gudang dikirimi pesan dan bagian Bekasi
 * SELALU nge-tag, termasuk waktu orang Bekasi sendiri yang barusan mencetak —
 * keluhan head fulfillment 2026-07-27: "gua yang ngeprint juga bakal muncul di
 * pisah kirim". Dari 19 order terpisah dalam 30 hari, 11 cetakan pertamanya
 * datang dari orang grup 1; tag pada 11 order itu memang tidak ada gunanya.
 *
 * KALAU LOKASINYA KOSONG. 19 admin (dan user yang sudah dihapus) tidak punya
 * `office_location`. Cetakan mereka tidak bisa dihubungkan ke gudang manapun,
 * jadi dipakai rem lama: kalau jumlah cetakan tak-dikenal itu sudah sebanyak
 * gudang yang tersisa, anggap saja sudah tercetak dan diamkan. Kasar, tapi
 * hanya berlaku untuk sisa kecil (2 dari 19 order).
 *
 * OBAT YANG PALING BERSIH tetap menulis `packGroupId` ke
 * `admin_logs.information` (satu baris di `OrderController::
 * buildPrintAddressGroups`, `AdminOrderController::printAddressManual`, dan
 * keempat halaman gudang). Keputusan user 2026-07-20, 2026-07-27, dan 2026-08-06:
 * JANGAN sentuh backend — semua diselesaikan dari sisi bot. Pencocokan klik di
 * atas adalah bentuk terdekat yang bisa dicapai tanpa itu; sisa tebakannya cuma
 * untuk cetakan yang tidak lewat tautan bot.
 */

const EMBED_COLOR = 0xe67e22;

/**
 * Group 1 = Bekasi. Dibedakan bukan karena gudangnya istimewa, tapi karena yang
 * ditagih beda orangnya: bagian Bekasi ditujukan ke head fulfillment, gudang
 * lain ke channelnya sendiri.
 */
const GROUP_BEKASI = 1;

/**
 * KLIK YANG DIAKUI. Tautan cetak di pesan ini lewat `/print/<order>/<grup>` di
 * server bot dulu, jadi bot tahu gudang mana yang dibuka — sesuatu yang tidak
 * disimpan `admin_logs` sama sekali.
 *
 * Kliknya BUKAN bukti cetak (sesi bisa habis dan orangnya mendarat di halaman
 * login), jadi yang dipakai adalah pasangannya: catatan cetak yang jatuh di
 * jendela sesudah klik dianggap berasal dari gudang yang diklik itu. Tidak ada
 * catatan → kliknya tidak berarti apa-apa dan gudangnya tetap dipanggil.
 *
 * Nilai-nilainya ditulis langsung ke SQL, jadi disaring dulu: order harus
 * angka, grup harus bilangan bulat 1-99, jam harus DATETIME apa adanya.
 */
function klikSah(): PrintClick[] {
  return daftarKlik().filter(
    (c) =>
      /^\d+$/.test(c.orderId) &&
      Number.isInteger(c.packGroupId) &&
      c.packGroupId > 0 &&
      c.packGroupId < 100 &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(c.at)
  );
}

/** Satu catatan cetak jatuh di jendela klik ini. */
function jendelaKlik(c: PrintClick): string {
  return `(alp.order_id = ${c.orderId} AND alp.created_at >= '${c.at}' AND alp.created_at <= '${geserMenit(c.at, JENDELA_KLIK_MENIT)}')`;
}

/** Catatan cetak ini sudah diklaim oleh SEBUAH klik — grup mana pun. */
export function diklaimSiapaPun(klik: PrintClick[]): string {
  if (klik.length === 0) return "FALSE";
  return `(${klik.map(jendelaKlik).join(" OR ")})`;
}

/** Catatan cetak ini diklaim klik untuk gudang yang sedang diperiksa. */
export function diklaimGrupIni(klik: PrintClick[], kolomGrup: string): string {
  if (klik.length === 0) return "FALSE";
  return `(${klik.map((c) => `(${kolomGrup} = ${c.packGroupId} AND ${jendelaKlik(c)})`).join(" OR ")})`;
}

/**
 * Potongan SQL: benar tepat ketika bagian gudang ini sudah dicetak.
 *
 * Dua jalur, dan urutannya penting:
 *
 *  1. CATATAN YANG DIKLAIM KLIK — dipakai apa adanya. Ini yang pasti: angkanya
 *     datang dari tautan yang dikirim bot sendiri, bukan dari siapa yang login.
 *
 *  2. CATATAN YANG TIDAK DIKLAIM SIAPA PUN — jatuh ke tebakan lama:
 *     `users.office_location` → `item_sources.name` → `pack_group_id`.
 *     Dipertahankan karena cetakan dari halaman /admin (yang tidak lewat
 *     tautan bot) memang tidak punya klik, dan karena 2,6 juta catatan lama
 *     tidak akan pernah punya. Untuk halaman gudang `/admin/alpha|beta|gamma|
 *     omega` tebakan ini justru tepat: rutenya dijaga middleware lokasi, jadi
 *     orang BETA memang cuma bisa mencetak dari halaman BETA.
 *
 * Yang berubah dibanding versi lama: catatan yang SUDAH diklaim klik tidak lagi
 * ikut ditebak. Itu yang menutup kasus "orang Bekasi membuka tautan Tangerang"
 * — dulu catatan itu membungkam Bekasi, sekarang dia menandai Tangerang.
 *
 * JOIN-nya jadi LEFT: catatan yang diklaim klik harus tetap terhitung meskipun
 * pencetaknya tidak punya lokasi kerja.
 */
export function sudahDicetakGudangIni(kolomGrup: string, klik: PrintClick[]): string {
  return `
        EXISTS (
          SELECT 1
          FROM admin_logs alp
          LEFT JOIN users pu           ON pu.user_id = alp.user_id
          LEFT JOIN item_sources psrc  ON psrc.name  = pu.office_location
          WHERE alp.order_id = o.order_id
            AND alp.action IN ('print_order_address', 'print_order_address_manual')
            AND (
              ${diklaimGrupIni(klik, kolomGrup)}
              OR (NOT ${diklaimSiapaPun(klik)} AND psrc.pack_group_id = ${kolomGrup})
            )
        )`.trim();
}

type SplitRow = {
  orderId: string;
  packGroupId: number;
  kota: string;
  gudang: string;
  pcs: number;
  gram: number;
  barang: string[];
  customer: string;
  kurir: string;
  dicetakPada: string;
};

function metabaseConfig(): MetabaseConfig | null {
  if (!env.METABASE_URL || !env.METABASE_EMAIL || !env.METABASE_PASSWORD) return null;
  return {
    url: env.METABASE_URL,
    email: env.METABASE_EMAIL,
    password: env.METABASE_PASSWORD,
    databaseId: env.METABASE_DATABASE_ID
  };
}

/**
 * Berat yang akan tercetak di label, dalam kg — rumus PERSIS dari kyou.id
 * (`resources/views/admin/orders/address.blade.php`). Ditampilkan supaya orang
 * gudang bisa mencocokkan dengan label yang keluar; kalau beda, ada yang salah.
 */
export function labelKg(gram: number): number {
  if (gram < 1000) return 1;
  if (((gram % 400) % 100) !== 0) return Math.round((gram + 100) / 1000);
  return Math.round(gram / 1000);
}

/** Waktu cetak terbaru yang ada di database. Jadi batas atas putaran ini. */
function watermarkQuery(): string {
  return `
    SELECT MAX(al.created_at) AS terbaru
    FROM admin_logs al
    WHERE al.action IN ('print_order_address', 'print_order_address_manual')
  `.trim();
}

/**
 * Order yang BARU dicetak (di antara watermark lama & baru) dan punya barang di
 * gudang jauh. Satu baris = satu gudang pada satu order.
 *
 * Catatan cetaknya dipakai lewat EXISTS, BUKAN JOIN. Ini bukan gaya-gayaan:
 * JOIN ke admin_logs menggandakan baris item sebanyak jumlah catatan cetak —
 * order 396668 punya 5 catatan, dan beratnya sempat terbaca 5.000 g padahal
 * aslinya 1.000 g.
 */
function splitQuery(sejak: string, sampai: string, klik: PrintClick[]): string {
  return `
    SELECT
      o.order_id                                   AS order_id,
      s.pack_group_id                              AS pack_group_id,
      MAX(COALESCE(d.name, '-'))                   AS kota,
      GROUP_CONCAT(DISTINCT oi.source ORDER BY oi.source SEPARATOR ', ') AS gudang,
      SUM(oi.quantity)                             AS pcs,
      SUM(i.weight * oi.quantity)                  AS gram,
      GROUP_CONCAT(
        CONCAT(oi.quantity, 'x ', COALESCE(NULLIF(oi.item_name, ''), i.name))
        ORDER BY oi.id SEPARATOR '||'
      )                                            AS barang,
      MAX(u.name)                                  AS customer,
      MAX(o.shipping_type)                         AS kurir,
      (SELECT MAX(al.created_at) FROM admin_logs al
        WHERE al.order_id = o.order_id
          AND al.action IN ('print_order_address', 'print_order_address_manual')
      )                                            AS dicetak_pada
    FROM orders o
    JOIN users u        ON u.user_id  = o.user_id
    JOIN order_items oi ON oi.order_id = o.order_id
    JOIN items i        ON i.item_id   = oi.item_id
    JOIN item_sources s ON s.name      = oi.source
    LEFT JOIN districts d ON d.district_id = s.district_id
    WHERE o.status = 'paid'
      -- SEMUA gudang, bukan cuma yang jauh. Barang tanpa pack group (PO/UREQ,
      -- source kosong) tetap terlewat: sebenarnya barang begitu ikut label
      -- Group 1, tapi jumlahnya kecil (47 baris dalam 30 hari) dan menambalnya
      -- butuh meniru aturan PO/UREQ dari Order::itemsForPackGroup. Akibatnya
      -- cuma satu: berat & isi label Bekasi yang ditampilkan bisa kurang dari
      -- yang benar-benar tercetak kalau ordernya memuat barang PO/UREQ.
      AND s.pack_group_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM admin_logs al
        WHERE al.order_id = o.order_id
          AND al.action IN ('print_order_address', 'print_order_address_manual')
          AND al.created_at >  '${sejak}'
          AND al.created_at <= '${sampai}'
          -- Penandaan "partner mencetak sendiri" dari papan kakera memakai
          -- catatan yang sama supaya /admin lama & PDA ikut melihatnya, tapi
          -- TIDAK boleh memicu pesan ini: labelnya dicetak partner di luar
          -- sistem, jadi memanggil gudang lain untuk mencetak bagiannya cuma
          -- menyuruh orang mengerjakan sesuatu yang tidak ada.
          AND al.information NOT LIKE '%"partner_self_print":true%'
      )
      -- Cuma order yang pengirimannya BENAR-BENAR terpisah. Dulu ini kebetulan
      -- terjaga oleh hitungan "cetak < gudang" (order satu gudang selalu 1 >= 1
      -- begitu dicetak). Hitungan itu diganti, jadi syaratnya ditulis eksplisit
      -- — tanpa ini order biasa yang kebetulan dicetak orang gudang lain ikut
      -- terkirim.
      AND (
        SELECT COUNT(DISTINCT s3.pack_group_id)
        FROM order_items oi3
        JOIN item_sources s3 ON s3.name = oi3.source
        WHERE oi3.order_id = o.order_id
          AND s3.pack_group_id IS NOT NULL
      ) > 1
      -- Gudang yang SUDAH mencetak bagiannya tidak usah dikirimi apa-apa. Ini
      -- yang bikin head fulfillment berhenti ketag waktu dia sendiri yang
      -- mencetak: begitu ada orang berlokasi Bekasi mencetak order ini, baris
      -- grup 1 hilang — dan tag menempel pada baris grup 1.
      AND NOT ${sudahDicetakGudangIni("s.pack_group_id", klik)}
      -- Rem untuk cetakan yang pencetaknya tidak punya lokasi (tidak bisa
      -- dihubungkan ke gudang manapun): kalau jumlahnya sudah sebanyak gudang
      -- yang belum ketahuan mencetak, anggap sudah beres dan diam. Ini hitungan
      -- kasar yang lama, sekarang cuma dipakai untuk sisa kecil ini — bukan
      -- lagi satu-satunya rem.
      --
      -- Catatan yang sudah diklaim klik DIKELUARKAN dari hitungan ini: gudangnya
      -- sudah ketahuan pasti di atas, jadi menghitungnya lagi sebagai "tak
      -- dikenal" akan membungkam gudang yang justru belum mencetak.
      AND (
        SELECT COUNT(*)
        FROM admin_logs al2
        LEFT JOIN users uu          ON uu.user_id = al2.user_id
        LEFT JOIN item_sources usrc ON usrc.name  = uu.office_location
        WHERE al2.order_id = o.order_id
          AND al2.action IN ('print_order_address', 'print_order_address_manual')
          AND usrc.pack_group_id IS NULL
          AND NOT ${diklaimSiapaPun(klik).replace(/alp\./g, "al2.")}
      ) < (
        SELECT COUNT(DISTINCT s2.pack_group_id)
        FROM order_items oi2
        JOIN item_sources s2 ON s2.name = oi2.source
        WHERE oi2.order_id = o.order_id
          AND s2.pack_group_id IS NOT NULL
          AND NOT ${sudahDicetakGudangIni("s2.pack_group_id", klik)}
      )
    GROUP BY o.order_id, s.pack_group_id
    ORDER BY dicetak_pada ASC
  `.trim();
}

/**
 * Ubah nilai waktu dari Metabase jadi DATETIME MySQL apa adanya —
 * "2026-07-13T16:04:16+07:00" → "2026-07-13 16:04:16".
 *
 * SENGAJA tidak lewat `new Date()`. Sesi MySQL berjalan di UTC (`NOW()` = 10:30)
 * padahal `admin_logs.created_at` disimpan dalam jam WIB (16:04) — beda 7 jam.
 * Metabase menempelkan penanda "+07:00" pada nilai yang sebenarnya sudah WIB,
 * jadi kalau di-parse jadi Date, JS akan menggesernya 7 jam mundur dan jendela
 * waktunya meleset: query tidak akan pernah menemukan apa pun. Perlakukan
 * nilainya sebagai teks, jangan sebagai waktu.
 */
function toMysqlDatetime(raw: unknown): string {
  return String(raw ?? "").trim().replace("T", " ").replace(/(\+\d{2}:\d{2}|Z)$/, "").slice(0, 19);
}

async function fetchSplits(
  config: MetabaseConfig,
  sejak: string,
  sampai: string,
  klik: PrintClick[]
): Promise<SplitRow[]> {
  const { columns, rows } = await fetchNativeQueryWithPagination(config, splitQuery(sejak, sampai, klik));
  const idx = (name: string) => columns.indexOf(name);

  return rows.map((row): SplitRow => ({
    orderId: String(row[idx("order_id")] ?? "").trim(),
    packGroupId: Number(row[idx("pack_group_id")] ?? 0),
    kota: String(row[idx("kota")] ?? "-").trim() || "-",
    gudang: String(row[idx("gudang")] ?? "-").trim() || "-",
    pcs: Number(row[idx("pcs")] ?? 0),
    gram: Number(row[idx("gram")] ?? 0),
    barang: String(row[idx("barang")] ?? "").split("||").filter(Boolean),
    customer: String(row[idx("customer")] ?? "-").trim() || "-",
    kurir: String(row[idx("kurir")] ?? "-").trim() || "-",
    dicetakPada: String(row[idx("dicetak_pada")] ?? "")
  }));
}

// Field value Discord dibatasi 1024 karakter — order berisi belasan barang bisa
// menggagalkan pengiriman pesannya sama sekali (pelajaran dari pick-triage).
const MAX_ITEM_CHARS = 900;

function daftarBarang(barang: string[]): string {
  if (barang.length === 0) return "-";
  const baris: string[] = [];
  let chars = 0;
  for (const [i, nama] of barang.entries()) {
    const line = `${i + 1}. ${nama.length > 110 ? nama.slice(0, 109) + "…" : nama}`;
    if (chars + line.length + 1 > MAX_ITEM_CHARS) break;
    baris.push(line);
    chars += line.length + 1;
  }
  const sisa = barang.length - baris.length;
  if (sisa > 0) baris.push(`_…dan ${sisa} barang lainnya_`);
  return baris.join("\n");
}

function embedFor(row: SplitRow): EmbedBuilder {
  // Lewat bot kalau alamat publiknya diisi, supaya gudang yang dibuka tercatat.
  // Kalau tidak, tautan langsung seperti sebelumnya — tidak ada yang hilang
  // selain ketepatan tebakannya.
  const url =
    printLabelClickUrl(row.orderId, row.packGroupId, env.SPLIT_PRINT_LINK_BASE) ??
    printLabelUrl(row.orderId, row.packGroupId);
  const kg = labelKg(row.gram);
  const bekasi = row.packGroupId === GROUP_BEKASI;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`📦 #${row.orderId} — ada barang di ${row.kota}`)
    .setDescription(
      [
        bekasi
          ? `Order ${orderLink(row.orderId)} ini **pengirimannya terpisah** dan salah satu bagiannya ` +
            `ada di **${row.kota}**. Tolong pastikan label bagian ini ikut tercetak.`
          : `Order ${orderLink(row.orderId)} ini **pengirimannya terpisah** — tiap gudang kirim paketnya ` +
            `sendiri, jadi bagian **${row.kota}** perlu label sendiri.`,
        "",
        // Peringatan ditaruh DI ATAS tautan. Di bawah, orang sudah terlanjur
        // mengklik sebelum sempat membacanya.
        "-# ⚠️ Membuka link ini **langsung mencetak label** dan tercatat di admin logs atas namamu.",
        `-# Jangan dibuka kalau cuma mau lihat isinya — barang, berat, dan kurirnya sudah ada di pesan ini.`,
        url ? `### 🖨️ [Cetak label ${row.kota}](${url})` : "_Link cetak tidak tersedia._",
        "",
        `-# Label ini hanya berisi barang ${row.gudang} — berat & isinya sudah dipisah otomatis.`,
        `-# Kalau bagian ${row.kota} barusan kamu cetak, abaikan pesan ini.`
      ].join("\n")
    )
    .addFields(
      { name: "Barang", value: daftarBarang(row.barang) },
      { name: "Jumlah", value: `${row.pcs} pcs`, inline: true },
      { name: "Berat label", value: `± ${kg} kg _(${row.gram} g)_`, inline: true },
      { name: "Kurir", value: row.kurir, inline: true },
      { name: "Customer", value: row.customer, inline: true }
    );

  return embed;
}

export async function runSplitPrintCheck(client: Client): Promise<void> {
  const config = metabaseConfig();
  if (!config) {
    console.warn("[split-print] Metabase belum dikonfigurasi — lewati.");
    return;
  }

  // Batas atas diambil DULU, sebelum menarik barisnya. Kalau tidak, catatan cetak
  // yang masuk di sela dua query akan terlewat selamanya.
  const wm = await fetchNativeQueryWithPagination(config, watermarkQuery());
  const sampai = toMysqlDatetime(wm.rows[0]?.[0]);
  if (!sampai) return;

  // Putaran pertama (store kosong / hilang): watermark di-set = cetakan terakhir
  // yang ada sekarang, jadi backlog lama sengaja dilewat.
  const sejak = getOrInitWatermark(sampai);

  // Perbandingan string aman: format DATETIME MySQL berurut secara leksikografis.
  if (sampai <= sejak) return; // tak ada cetakan baru

  const rows = await fetchSplits(config, sejak, sampai, klikSah());
  const baru = rows.filter((r) => r.orderId && !isPosted(r.orderId, r.packGroupId));

  if (baru.length === 0) {
    setWatermark(sampai);
    return;
  }

  const channel = (await client.channels.fetch(env.SPLIT_PRINT_CHANNEL_ID).catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) {
    console.error(`[split-print] channel ${env.SPLIT_PRINT_CHANNEL_ID} tidak ketemu — watermark TIDAK digeser supaya tidak ada yang hilang.`);
    return;
  }

  for (const row of baru) {
    try {
      // Cuma bagian Bekasi yang nge-tag orang. `allowedMentions` wajib diisi:
      // tanpa itu tag-nya jadi teks mati dan tidak ada yang kena notifikasi.
      const mentionId =
        row.packGroupId === GROUP_BEKASI ? env.SPLIT_PRINT_BEKASI_MENTION_USER_ID : "";

      const message = await channel.send({
        content: mentionId ? `<@${mentionId}>` : undefined,
        embeds: [embedFor(row)],
        allowedMentions: { users: mentionId ? [mentionId] : [] }
      });
      markPosted({
        orderId: row.orderId,
        packGroupId: row.packGroupId,
        kota: row.kota,
        channelId: channel.id,
        messageId: message.id,
        at: new Date().toISOString()
      });
    } catch (err) {
      console.error(`[split-print] gagal kirim #${row.orderId} grup ${row.packGroupId}:`, err);
    }
  }

  // Watermark digeser SETELAH pesan terkirim. Kalau digeser duluan lalu
  // pengiriman gagal, ordernya hilang selamanya dari pantauan.
  setWatermark(sampai);
  console.log(`[split-print] ${baru.length} kiriman terpisah dikirim ke channel.`);
}

export function startSplitPrintScheduler(client: Client): void {
  if (!env.SPLIT_PRINT_ENABLED) {
    console.log("[split-print] poller nonaktif (SPLIT_PRINT_ENABLED=false).");
    return;
  }

  const intervalMs = env.SPLIT_PRINT_POLL_MINUTES * 60_000;
  let running = false;

  const tick = async () => {
    if (running) {
      console.warn("[split-print] putaran sebelumnya belum selesai — lewati.");
      return;
    }
    running = true;
    try {
      await runSplitPrintCheck(client);
    } catch (err) {
      console.error("[split-print] gagal cek:", err);
    } finally {
      running = false;
    }
  };

  setInterval(tick, intervalMs).unref?.();
  void tick();
  console.log(`[split-print] poller aktif — cek tiap ${env.SPLIT_PRINT_POLL_MINUTES} menit.`);
}
