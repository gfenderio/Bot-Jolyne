import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import { getOrInitWatermark, setWatermark, isPosted, markPosted } from "../services/splitPrintStore.js";
import { orderLink, printLabelUrl } from "../services/kyouLinks.js";

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
 * BARU, lalu memeriksa: order itu punya barang di Group 2/3 (Tangerang/Surabaya)?
 * Kalau ya → kirim satu pesan berisi link cetak khusus gudang itu.
 *
 * KENAPA GROUP 1 (BEKASI) TIDAK PERNAH DIKIRIMI LINK. Bekasi mencetak sendiri
 * dari halaman fulfillment — merekalah yang jadi pemicunya. Data 45 hari
 * membenarkan: dari 124 order terpisah, SEMUANYA melibatkan Group 1 (105 dgn
 * Tangerang, 17 dgn Surabaya, 2 dgn keduanya). Tidak ada satu pun order terpisah
 * tanpa Bekasi — jadi "yang mencetak duluan = Bekasi" adalah asumsi yang aman.
 *
 * YANG TIDAK BISA DILAKUKAN BOT INI. `admin_logs` TIDAK menyimpan gudang mana
 * yang dicetak — jadi bot tidak bisa tahu apakah label Tangerang sudah dicetak
 * atau belum. Dia cuma memberi tahu SEKALI, lalu diam (keputusan user: tanpa
 * tombol konfirmasi, tanpa penagihan). Kalau suatu saat ingin bot benar-benar
 * mengejar yang belum dicetak, kyou.id harus menyimpan `packGroupId` ke
 * admin_logs — itu perubahan backend, dan sengaja dihindari di sini.
 */

const EMBED_COLOR = 0xe67e22;

/** Group 1 = Bekasi (pemicu, tak pernah dikirimi link). Sisanya yang ditagih. */
const GUDANG_JAUH = [2, 3];

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
function splitQuery(sejak: string, sampai: string): string {
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
      AND s.pack_group_id IN (${GUDANG_JAUH.join(",")})
      AND EXISTS (
        SELECT 1 FROM admin_logs al
        WHERE al.order_id = o.order_id
          AND al.action IN ('print_order_address', 'print_order_address_manual')
          AND al.created_at >  '${sejak}'
          AND al.created_at <= '${sampai}'
      )
      -- Cuma kirim kalau JUMLAH CETAK masih KURANG dari JUMLAH GUDANG.
      --
      -- Tanpa ini bot berisik dan menyebalkan: yang mencetak sering justru staf
      -- gudang jauh itu sendiri (Savira rutin mencetak label Tangerang), jadi
      -- bot akan menagih pekerjaan yang baru saja selesai. Diuji pada cetakan
      -- 13:00-16:04 tgl 13 Jul: 14 baris turun jadi 8 — yang didiamkan persis
      -- order yang sudah dicetak >= jumlah gudangnya (396668 sudah 5x cetak).
      --
      -- Ini heuristik, bukan kebenaran: admin_logs TIDAK menyimpan gudang mana
      -- yang dicetak, jadi cetak-ulang di gudang yang sama ikut terhitung dan
      -- bisa membuat order yang benar-benar kurang label jadi terlewat. Satu-
      -- satunya obat yang jujur adalah menyimpan packGroupId ke admin_logs
      -- (perubahan backend kyou.id, sengaja dihindari).
      AND (
        SELECT COUNT(*) FROM admin_logs al2
        WHERE al2.order_id = o.order_id
          AND al2.action IN ('print_order_address', 'print_order_address_manual')
      ) < (
        SELECT COUNT(DISTINCT s2.pack_group_id)
        FROM order_items oi2
        JOIN item_sources s2 ON s2.name = oi2.source
        WHERE oi2.order_id = o.order_id
          AND s2.pack_group_id IS NOT NULL
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

async function fetchSplits(config: MetabaseConfig, sejak: string, sampai: string): Promise<SplitRow[]> {
  const { columns, rows } = await fetchNativeQueryWithPagination(config, splitQuery(sejak, sampai));
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
  const url = printLabelUrl(row.orderId, row.packGroupId);
  const kg = labelKg(row.gram);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`📦 #${row.orderId} — ada barang di ${row.kota}`)
    .setDescription(
      [
        `Order ${orderLink(row.orderId)} ini **pengirimannya terpisah**. Bagian Bekasi sudah dicetak; ` +
          `bagian **${row.kota}** perlu label sendiri.`,
        "",
        url ? `### 🖨️ [Cetak label ${row.kota}](${url})` : "_Link cetak tidak tersedia._",
        "",
        `-# Label ini hanya berisi barang ${row.gudang} — berat & isinya sudah dipisah otomatis.`
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

  const rows = await fetchSplits(config, sejak, sampai);
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
      const message = await channel.send({ embeds: [embedFor(row)] });
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
