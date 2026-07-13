import fs from "fs";
import path from "path";
import { env } from "../config/env.js";

/**
 * Store untuk fitur "kiriman terpisah — label gudang lain".
 *
 * Dua isinya:
 *
 * - `lastSeenPrintAt` : batas air (watermark) waktu cetak terakhir yang sudah
 *   diproses. Poll berikutnya cuma melihat catatan cetak yang LEBIH BARU dari
 *   ini. Kalau store belum ada (bot pertama kali jalan / store hilang saat
 *   redeploy), nilainya di-set = SEKARANG — jadi backlog lama sengaja dilewat,
 *   sesuai keputusan "mulai dari sekarang saja". Ini juga yang mencegah bot
 *   memblast 82 order lama ke channel begitu pertama nyala.
 *
 * - `posted` : kunci `<orderId>:<packGroupId>`, supaya satu gudang pada satu
 *   order dikirim TEPAT SEKALI. Order yang dicetak berkali-kali (396668 tercatat
 *   5x cetak) tidak akan menghasilkan pesan berulang.
 *
 * Sama seperti pickTriageStore: file JSON biasa, TANPA volume persisten. Kalau
 * hilang saat redeploy, watermark di-set ulang ke sekarang → yang terlewat di
 * masa jeda tidak akan dikirim. Itu konsekuensi yang diterima; jauh lebih baik
 * daripada membanjiri channel dengan seluruh riwayat.
 */

export interface PostedSplit {
  orderId: string;
  packGroupId: number;
  kota: string;
  channelId: string;
  messageId: string;
  at: string; // ISO
}

interface SplitPrintStore {
  lastSeenPrintAt: string | null; // ISO
  posted: Record<string, PostedSplit>;
}

function storePath(): string {
  return env.SPLIT_PRINT_STORE_PATH;
}

function readStore(): SplitPrintStore {
  const file = storePath();
  if (!fs.existsSync(file)) {
    return { lastSeenPrintAt: null, posted: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return {
      lastSeenPrintAt: parsed.lastSeenPrintAt ?? null,
      posted: parsed.posted ?? {}
    };
  } catch {
    return { lastSeenPrintAt: null, posted: {} };
  }
}

function writeStore(store: SplitPrintStore) {
  const dir = path.dirname(storePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf-8");
}

const key = (orderId: string, packGroupId: number) => `${orderId}:${packGroupId}`;

/**
 * Watermark saat ini, dalam format DATETIME MySQL ("2026-07-13 16:04:16").
 *
 * Kalau belum ada, ditetapkan = `dbNow` (waktu cetak TERAKHIR yang ada di
 * database) lalu disimpan — jadi putaran pertama tidak menemukan apa pun dan
 * backlog lama terlewat dengan sengaja.
 *
 * Patokannya diambil dari DATABASE, bukan jam JS. Ini bukan kerewelan: sesi
 * MySQL berjalan di UTC (`NOW()` = 10:30) sementara `admin_logs.created_at`
 * ternyata disimpan dalam jam WIB (16:04) — beda 7 jam. Begitu jam JS ikut
 * campur, jendela waktunya meleset dan bot tidak akan menemukan apa pun.
 * Jangan pernah membandingkan kolom ini dengan NOW() atau dengan Date() JS.
 */
export function getOrInitWatermark(dbNow: string): string {
  const store = readStore();
  if (store.lastSeenPrintAt) return store.lastSeenPrintAt;

  store.lastSeenPrintAt = dbNow;
  writeStore(store);
  return store.lastSeenPrintAt;
}

export function setWatermark(at: string) {
  const store = readStore();
  store.lastSeenPrintAt = at;
  writeStore(store);
}

export function isPosted(orderId: string, packGroupId: number): boolean {
  return Boolean(readStore().posted[key(orderId, packGroupId)]);
}

export function markPosted(entry: PostedSplit) {
  const store = readStore();
  store.posted[key(entry.orderId, entry.packGroupId)] = entry;
  writeStore(store);
}
