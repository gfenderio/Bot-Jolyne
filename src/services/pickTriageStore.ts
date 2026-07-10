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

export function isResolved(itemId: string): boolean {
  return Boolean(readStore().resolved[itemId]);
}

export function getResolved(itemId: string): ResolvedItem | undefined {
  return readStore().resolved[itemId];
}

export function getPosted(itemId: string): PostedItem | undefined {
  return readStore().posted[itemId];
}

/** Sudah pernah diposting? Dipakai poller supaya barang tidak dikirim dua kali. */
export function isPosted(itemId: string): boolean {
  return Boolean(readStore().posted[itemId]);
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
