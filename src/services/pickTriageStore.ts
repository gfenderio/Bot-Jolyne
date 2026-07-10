import fs from "fs";
import path from "path";
import { env } from "../config/env.js";

/**
 * Store persisten untuk fitur "Triase PICK 24 jam".
 *
 * - `posted`  : metadata tiap barang yang sudah diposting digest-nya, dipakai
 *               saat modal submit (handler tidak menerima detail barang, hanya
 *               itemId dari customId) dan untuk men-disable dropdown yang benar.
 * - `resolved`: barang yang sudah dijawab (opsi + deskripsi + siapa + kapan).
 *               Scheduler melewati itemId yang sudah ada di sini supaya tidak
 *               diposting ulang besok paginya.
 */

export type TriageChoice = "antri" | "rusak" | "ketemu";

export interface PostedItem {
  itemId: string;
  orderId: string;
  itemName: string;
  user: string;
  shipping: string;
  hours: number;
  channelId: string;
  messageId: string;
}

export interface ResolvedItem {
  choice: TriageChoice;
  note: string;
  byId: string;
  byTag: string;
  at: string; // ISO
}

interface TriageStore {
  posted: Record<string, PostedItem>;
  resolved: Record<string, ResolvedItem>;
  // Pesan yang diposting run terakhir (lead + tiap barang + empty-state), supaya
  // run berikutnya bisa hapus dulu sebelum kirim ulang — biar channel tidak numpuk.
  sent?: { channelId: string; messageIds: string[] };
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
      resolved: parsed.resolved ?? {},
      sent: parsed.sent
    };
  } catch {
    return { posted: {}, resolved: {} };
  }
}

function writeStore(store: TriageStore) {
  ensureStoreDir();
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf-8");
}

export function isResolved(itemId: string): boolean {
  return Boolean(readStore().resolved[itemId]);
}

export function getResolved(itemId: string): ResolvedItem | undefined {
  return readStore().resolved[itemId];
}

export function getPosted(itemId: string): PostedItem | undefined {
  return readStore().posted[itemId];
}

/** Semua barang yang diposting di satu pesan (urut sesuai urutan posting). */
export function getPostedByMessage(messageId: string): PostedItem[] {
  return Object.values(readStore().posted).filter((p) => p.messageId === messageId);
}

/** ID pesan yang diposting run terakhir (buat dihapus sebelum kirim ulang). */
export function getSentMessages(): { channelId: string; messageIds: string[] } | undefined {
  return readStore().sent;
}

export function setSentMessages(channelId: string, messageIds: string[]) {
  const store = readStore();
  store.sent = { channelId, messageIds };
  writeStore(store);
}

/** Simpan/replace metadata barang yang baru diposting. */
export function markPosted(item: PostedItem) {
  const store = readStore();
  store.posted[item.itemId] = item;
  writeStore(store);
}

/** Tandai barang sudah dijawab. Return false kalau ternyata sudah dijawab. */
export function markResolved(itemId: string, resolved: ResolvedItem): boolean {
  const store = readStore();
  if (store.resolved[itemId]) {
    return false;
  }
  store.resolved[itemId] = resolved;
  writeStore(store);
  return true;
}
