import fs from "fs";
import path from "path";
import { env } from "../config/env.js";

/**
 * Store persisten untuk fitur "Triase PICK 24 jam".
 *
 * Kunci store = ORDER ID (bukan item id). Satu order = satu pesan = satu
 * jawaban, walau isinya banyak barang nyangkut — dulu per item, dan satu order
 * berisi 5 barang membanjiri channel dengan 5 pesan identik.
 *
 * - `posted`  : metadata tiap order yang sudah diposting, dipakai saat modal
 *               submit (handler cuma menerima orderId dari customId) dan untuk
 *               men-disable dropdown pesan yang benar.
 * - `resolved`: order yang sudah dijawab (opsi + deskripsi + siapa + kapan).
 *               Poller melewati order yang sudah ada di sini supaya tidak
 *               diposting ulang di putaran berikutnya.
 *
 * Kompatibilitas: store yang ditulis versi lama ber-key ITEM ID (entrinya punya
 * `itemId` dan tanpa `items`). Entri itu tidak dibaca sebagai order, tapi tetap
 * dipakai `hasLegacyItem()` supaya barang yang sudah pernah dikirim per-item
 * tidak muncul lagi sebagai "order baru" setelah deploy.
 */

export type TriageChoice = "antri" | "rusak" | "ketemu";

export interface PostedOrder {
  orderId: string;
  itemIds: string[];
  itemNames: string[];
  user: string;
  shipping: string;
  hours: number;
  /** Pelunasan ditagih lewat tombol "Early" — barangnya boleh jadi belum datang. */
  isEarly?: boolean;
  /** Perkiraan barang datang (orders.eta), mis. "July-August 2026". */
  eta?: string;
  channelId: string;
  messageId: string;
}

/** Entri store versi lama (satu baris per barang). */
interface LegacyPostedItem {
  itemId: string;
  orderId: string;
  itemName: string;
}

export interface ResolvedOrder {
  choice: TriageChoice;
  note: string;
  byId: string;
  byTag: string;
  at: string; // ISO
}

interface TriageStore {
  posted: Record<string, PostedOrder | LegacyPostedItem>;
  resolved: Record<string, ResolvedOrder>;
}

function storePath(): string {
  return env.PICK_TRIAGE_STORE_PATH;
}

function ensureStoreDir() {
  const dir = path.dirname(storePath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readStore(): TriageStore {
  ensureStoreDir();
  if (!fs.existsSync(storePath())) {
    return { posted: {}, resolved: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf-8"));
    return {
      posted: parsed.posted ?? {},
      resolved: parsed.resolved ?? {}
    };
  } catch {
    return { posted: {}, resolved: {} };
  }
}

function writeStore(store: TriageStore) {
  ensureStoreDir();
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf-8");
}

function isLegacy(entry: PostedOrder | LegacyPostedItem): entry is LegacyPostedItem {
  return !Array.isArray((entry as PostedOrder).itemIds);
}

export function isResolved(orderId: string): boolean {
  return Boolean(readStore().resolved[orderId]);
}

export function getResolved(orderId: string): ResolvedOrder | undefined {
  return readStore().resolved[orderId];
}

export function getPosted(orderId: string): PostedOrder | undefined {
  const entry = readStore().posted[orderId];
  if (!entry || isLegacy(entry)) return undefined;
  return entry;
}

/** Sudah pernah diposting? Dipakai poller supaya order tidak dikirim dua kali. */
export function isPosted(orderId: string): boolean {
  const entry = readStore().posted[orderId];
  return Boolean(entry) && !isLegacy(entry!);
}

/**
 * Barang ini sudah pernah dikirim/dijawab oleh versi lama (yang ber-key item)?
 * Tanpa ini, order yang barangnya sudah dikirim satu-satu sebelum deploy akan
 * muncul sekali lagi sebagai pesan order.
 */
export function hasLegacyItem(itemId: string): boolean {
  const entry = readStore().posted[itemId];
  return Boolean(entry) && isLegacy(entry!);
}

/** Simpan/replace metadata order yang baru diposting. */
export function markPosted(order: PostedOrder) {
  const store = readStore();
  store.posted[order.orderId] = order;
  writeStore(store);
}

/** Tandai order sudah dijawab. Return false kalau ternyata sudah dijawab. */
export function markResolved(orderId: string, resolved: ResolvedOrder): boolean {
  const store = readStore();
  if (store.resolved[orderId]) {
    return false;
  }
  store.resolved[orderId] = resolved;
  writeStore(store);
  return true;
}
