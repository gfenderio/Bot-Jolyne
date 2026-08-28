import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Buku catatan pengiriman bukti foto Machitan.
 *
 * Dua gunanya:
 *  1. Penyaring kembar. PDA sekarang menyimpan bukti yang gagal kirim lalu
 *     mengirimnya ulang. Kalau kiriman pertama sebenarnya sampai tapi jawabannya
 *     yang hilang, tanpa buku ini kanal Discord kemasukan pesan dobel.
 *  2. Jejak "diterima" yang terpisah dari "terposting". Sebelum ini bukti baru
 *     dicatat SETELAH Discord berhasil, jadi kiriman yang gagal tidak
 *     meninggalkan jejak apa pun di server dan tidak ada yang bisa menjawab
 *     "yang mana yang hilang" selain membuka log.
 *
 * Sengaja terpisah dari machitan-proofs.json: berkas itu dikosongkan tiap kali
 * laporan harian terkirim, sedangkan buku ini harus bertahan lintas hari.
 */

export type ProofDeliveryRecord = {
  key: string;
  proofType: string;
  orderIds: string[];
  itemIds: string[];
  /** Pasangan "invoice|item" — satu kiriman bisa memuat beberapa order sekaligus. */
  pairs?: string[];
  receivedAt: string;
  postedAt: string | null;
  error?: string;
  /**
   * Pesan Discord hasil posting bukti ini. Disimpan supaya kartu BATAL PICK
   * bisa membalas kartu aslinya, bukan berdiri sendiri di tengah channel —
   * kartu batal yang tidak bertaut membuat orang yang menemukan kartu hijau
   * lama tetap mengira barangnya sudah diambil.
   *
   * Boleh kosong, dan itu keadaan normal: catatan ini tinggal di `data/` yang
   * hilang tiap redeploy, dan retensinya cuma 14 hari. Yang membaca WAJIB
   * punya jalan lain kalau tidak ketemu — lihat pickCancelIntake.
   */
  channelId?: string;
  messageId?: string;
};

const STORE_PATH = path.join(process.cwd(), "data", "machitan-proof-delivery.json");
const RETENTION_DAYS = 14;

let cache: Map<string, ProofDeliveryRecord> | null = null;
let writeLock: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(() => undefined, () => undefined);
  return run;
}

async function load(): Promise<Map<string, ProofDeliveryRecord>> {
  if (cache) return cache;

  const map = new Map<string, ProofDeliveryRecord>();
  let content = "";
  try {
    content = await fs.readFile(STORE_PATH, "utf-8");
  } catch {
    cache = map;
    return map;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as ProofDeliveryRecord;
      // Baris terakhir menang: "diterima" ditulis dulu, "terposting" menyusul.
      if (record?.key) map.set(record.key, record);
    } catch {
      // Satu baris rusak tidak boleh membuat seluruh buku dianggap kosong —
      // dianggap kosong berarti kiriman lama bisa terposting dua kali.
      console.error("Satu baris machitan-proof-delivery.json korup, dilewati.");
    }
  }

  cache = map;
  return map;
}

async function append(record: ProofDeliveryRecord): Promise<void> {
  const map = await load();
  map.set(record.key, record);
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.appendFile(STORE_PATH, `${JSON.stringify(record)}\n`, "utf-8");
}

/**
 * Kunci identitas satu kiriman. Dikembalikan null kalau kirimannya tidak punya
 * identitas yang stabil — lebih baik tidak menyaring sama sekali daripada
 * menganggap dua pick berbeda sebagai kiriman yang sama lalu membuangnya.
 */
export function deriveProofKey(input: {
  clientSubmitId?: unknown;
  proofType: string;
  picker: string;
  submittedAt?: unknown;
  orderIds: string[];
  itemIds: string[];
}): string | null {
  const clientSubmitId = String(input.clientSubmitId ?? "").trim();
  if (clientSubmitId) return `csid:${clientSubmitId}`;

  const submittedAt = String(input.submittedAt ?? "").trim();
  if (!submittedAt) return null;

  const material = [
    input.proofType,
    input.picker,
    submittedAt,
    input.orderIds.join(","),
    input.itemIds.join(",")
  ].join("|");

  return `sha:${crypto.createHash("sha1").update(material).digest("hex").slice(0, 20)}`;
}

/** Pesan turunan dari satu kiriman (e-com mengirim satu pesan per barang). */
export function messageKey(submitKey: string, suffix: string): string {
  return `${submitKey}#${suffix}`;
}

export async function isPosted(key: string | null): Promise<boolean> {
  if (!key) return false;
  const map = await load();
  return Boolean(map.get(key)?.postedAt);
}

export type ProofDeliveryMeta = {
  proofType: string;
  orderIds: string[];
  itemIds: string[];
  pairs?: string[];
  channelId?: string;
  messageId?: string;
};

export function markReceived(key: string | null, meta: ProofDeliveryMeta): Promise<void> {
  if (!key) return Promise.resolve();
  return withLock(async () => {
    const map = await load();
    if (map.get(key)?.postedAt) return; // sudah selesai, jangan mundur statusnya
    await append({
      key,
      proofType: meta.proofType,
      orderIds: meta.orderIds,
      itemIds: meta.itemIds,
      pairs: meta.pairs,
      receivedAt: new Date().toISOString(),
      postedAt: null
    });
  }).catch((err) => {
    // Buku catatan gagal ditulis bukan alasan menolak bukti — kirimannya tetap
    // diposting, cuma tanpa penyaring kembar untuk kiriman itu.
    console.error("Gagal mencatat penerimaan bukti Machitan:", err);
  });
}

/**
 * [meta] wajib diisi untuk pesan turunan (mis. satu pesan per barang e-com):
 * kunci turunan belum punya catatan sendiri, dan tanpa meta catatannya kosong —
 * pengawas bukti akan mengira pick itu tak pernah dibuktikan.
 */
export function markPosted(key: string | null, meta?: ProofDeliveryMeta): Promise<void> {
  if (!key) return Promise.resolve();
  return withLock(async () => {
    const map = await load();
    const existing = map.get(key);
    await append({
      key,
      proofType: meta?.proofType ?? existing?.proofType ?? "-",
      orderIds: meta?.orderIds ?? existing?.orderIds ?? [],
      itemIds: meta?.itemIds ?? existing?.itemIds ?? [],
      pairs: meta?.pairs ?? existing?.pairs,
      channelId: meta?.channelId ?? existing?.channelId,
      messageId: meta?.messageId ?? existing?.messageId,
      receivedAt: existing?.receivedAt ?? new Date().toISOString(),
      postedAt: new Date().toISOString()
    });
  }).catch((err) => {
    console.error("Gagal mencatat bukti Machitan yang sudah diposting:", err);
  });
}

export function markFailed(key: string | null, error: unknown): Promise<void> {
  if (!key) return Promise.resolve();
  return withLock(async () => {
    const map = await load();
    const existing = map.get(key);
    if (existing?.postedAt) return;
    await append({
      key,
      proofType: existing?.proofType ?? "-",
      orderIds: existing?.orderIds ?? [],
      itemIds: existing?.itemIds ?? [],
      pairs: existing?.pairs,
      receivedAt: existing?.receivedAt ?? new Date().toISOString(),
      postedAt: null,
      error: String(error instanceof Error ? error.message : error).slice(0, 300)
    });
  }).catch((err) => {
    console.error("Gagal mencatat kegagalan kirim bukti Machitan:", err);
  });
}

/**
 * Apakah pick e-commerce ini sudah pernah dibuktikan? Dicocokkan dengan nomor
 * invoice DAN item — satu invoice bisa berisi beberapa barang yang dipick
 * terpisah, jadi mencocokkan invoice saja akan menutupi barang yang bocor.
 */
export async function hasProofFor(invoiceNumber: string, itemId: string): Promise<boolean> {
  const invoice = invoiceNumber.trim();
  const item = itemId.trim();
  if (!invoice || !item) return false;

  const map = await load();
  const pair = `${invoice}|${item}`;
  for (const record of map.values()) {
    if (!record.postedAt) continue;
    // Kiriman berisi beberapa order sekaligus: mencocokkan daftar invoice dan
    // daftar item secara terpisah bisa mengesahkan pasangan yang tidak pernah
    // ada (invoice A + item milik invoice B). Pasangannya yang dicocokkan.
    if (record.pairs?.length) {
      if (record.pairs.includes(pair)) return true;
      continue;
    }
    if (record.orderIds.includes(invoice) && record.itemIds.includes(item)) return true;
  }
  return false;
}

/**
 * Pesan Discord milik satu pasangan invoice|item, kalau catatannya masih ada.
 *
 * Dipakai kartu BATAL PICK untuk membalas kartu aslinya. Memulangkan null itu
 * hasil yang WAJAR, bukan galat: catatan ini tinggal di `data/` yang hilang tiap
 * kali bot di-redeploy, dan umurnya dipangkas 14 hari. Pemanggil harus tetap
 * bisa bekerja tanpa jawabannya.
 */
export async function findProofMessage(
  invoiceNumber: string,
  itemId: string,
): Promise<{ channelId: string; messageId: string } | null> {
  const invoice = invoiceNumber.trim();
  const item = itemId.trim();
  if (!invoice || !item) return null;

  const map = await load();
  const pair = `${invoice}|${item}`;
  // Yang TERBARU dipakai kalau satu barang pernah dipick lebih dari sekali:
  // yang dibatalkan orang selalu pick terakhirnya, bukan yang berbulan lalu.
  let best: ProofDeliveryRecord | null = null;
  for (const record of map.values()) {
    if (!record.postedAt || !record.messageId || !record.channelId) continue;
    const cocok = record.pairs?.length
      ? record.pairs.includes(pair)
      : record.orderIds.includes(invoice) && record.itemIds.includes(item);
    if (!cocok) continue;
    if (!best || record.postedAt > best.postedAt!) best = record;
  }
  return best ? { channelId: best.channelId!, messageId: best.messageId! } : null;
}

/** Buang catatan lama supaya berkasnya tidak tumbuh selamanya. */
export async function pruneProofDelivery(): Promise<void> {
  await withLock(async () => {
    const map = await load();
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const kept = [...map.values()].filter((record) => {
      const time = Date.parse(record.postedAt ?? record.receivedAt);
      return !Number.isFinite(time) || time >= cutoff;
    });
    if (kept.length === map.size) return;

    cache = new Map(kept.map((record) => [record.key, record]));
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    const tmpPath = `${STORE_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, kept.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf-8");
    await fs.rename(tmpPath, STORE_PATH);
  }).catch((err) => {
    console.error("Gagal merapikan buku pengiriman bukti Machitan:", err);
  });
}
