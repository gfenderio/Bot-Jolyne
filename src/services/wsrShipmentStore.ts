import fs from "fs";
import path from "path";
import { env } from "../config/env.js";

/**
 * Store untuk "tiket kiriman WSR" ala Jolyne.
 *
 * Dua isinya:
 *
 * - `lastSeenBatchId`: watermark id kiriman terakhir yang sudah dibuatkan
 *   thread. Id AUTO_INCREMENT selalu naik — tidak ada jebakan zona waktu
 *   seperti kolom datetime (pelajaran dari split-print).
 *
 * - `tracked`: kiriman yang thread-nya masih HIDUP (belum done/cancelled),
 *   kunci = batchId. Poll berikutnya membandingkan status DB dengan
 *   `lastStatus`/`lastFailed` di sini untuk tahu kapan harus post update
 *   ("selesai", "dibatalkan", "gagal sebagian") lalu menutup thread.
 *
 * Kalau store hilang saat redeploy (tak ada volume persisten, sama seperti
 * store lain di repo ini): watermark di-set = id tertinggi saat itu, jadi
 * kiriman lama tidak diblast ulang; thread tiket yang masih terbuka saat
 * redeploy TIDAK akan di-update lagi oleh bot (konsekuensi yang diterima —
 * status aslinya selalu bisa dilihat di menu Kiriman PDA).
 */

export interface TrackedShipment {
  threadId: string;
  lastStatus: string;   // pending | running | done | cancelled
  lastFailed: number;   // jumlah barang berstatus failed saat terakhir dilihat
  unit: string;
}

interface WsrShipmentStore {
  lastSeenBatchId: number | null;
  tracked: Record<string, TrackedShipment>;
}

function storePath(): string {
  return env.WSR_SHIPMENT_STORE_PATH;
}

function readStore(): WsrShipmentStore {
  const file = storePath();
  if (!fs.existsSync(file)) return { lastSeenBatchId: null, tracked: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const id = Number(parsed.lastSeenBatchId);
    return {
      lastSeenBatchId: Number.isFinite(id) ? id : null,
      tracked: parsed.tracked ?? {}
    };
  } catch {
    return { lastSeenBatchId: null, tracked: {} };
  }
}

function writeStore(store: WsrShipmentStore): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf-8");
}

/** Putaran pertama: patok watermark ke id tertinggi supaya backlog lama dilewat. */
export function getOrInitWatermark(currentMaxId: number): number {
  const store = readStore();
  if (store.lastSeenBatchId === null) {
    writeStore({ ...store, lastSeenBatchId: currentMaxId });
    return currentMaxId;
  }
  return store.lastSeenBatchId;
}

export function setWatermark(id: number): void {
  const store = readStore();
  writeStore({ ...store, lastSeenBatchId: id });
}

export function trackShipment(batchId: number, info: TrackedShipment): void {
  const store = readStore();
  store.tracked[String(batchId)] = info;
  writeStore(store);
}

export function getTracked(): Record<string, TrackedShipment> {
  return readStore().tracked;
}

export function updateTracked(batchId: number, patch: Partial<TrackedShipment>): void {
  const store = readStore();
  const cur = store.tracked[String(batchId)];
  if (!cur) return;
  store.tracked[String(batchId)] = { ...cur, ...patch };
  writeStore(store);
}

export function untrack(batchId: number): void {
  const store = readStore();
  delete store.tracked[String(batchId)];
  writeStore(store);
}
