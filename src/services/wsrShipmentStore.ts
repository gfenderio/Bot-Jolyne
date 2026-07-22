import fs from "fs";
import path from "path";
import { env } from "../config/env.js";

/**
 * Store untuk fitur "kiriman WSR — daftar barang buat gudang".
 *
 * Isinya cuma satu: `lastSeenBatchId`, id kiriman terakhir yang sudah dikirim
 * ke Discord. Poll berikutnya hanya melihat id yang LEBIH BESAR.
 *
 * Kenapa pakai id, bukan waktu seperti splitPrintStore: id kiriman berasal dari
 * AUTO_INCREMENT — selalu naik, tak pernah bentrok, dan tidak perlu memikirkan
 * beda zona waktu antara server bot dan DB (jebakan yang sudah pernah kena di
 * fitur split-print: admin_logs jam WIB tapi NOW() UTC).
 *
 * Kalau store hilang saat redeploy (tak ada volume persisten, sama seperti
 * store lain di repo ini), watermark di-set = id tertinggi saat itu → kiriman
 * lama sengaja dilewat, bukan diblast ulang ke channel.
 */

interface WsrShipmentStore {
  lastSeenBatchId: number | null;
}

function storePath(): string {
  return env.WSR_SHIPMENT_STORE_PATH;
}

function readStore(): WsrShipmentStore {
  const file = storePath();
  if (!fs.existsSync(file)) return { lastSeenBatchId: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const id = Number(parsed.lastSeenBatchId);
    return { lastSeenBatchId: Number.isFinite(id) ? id : null };
  } catch {
    return { lastSeenBatchId: null };
  }
}

function writeStore(store: WsrShipmentStore): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Ambil batas bawah. Putaran pertama: dipatok ke id tertinggi yang ada sekarang,
 * jadi kiriman yang dibuat sebelum bot nyala tidak ikut terkirim.
 */
export function getOrInitWatermark(currentMaxId: number): number {
  const store = readStore();
  if (store.lastSeenBatchId === null) {
    writeStore({ lastSeenBatchId: currentMaxId });
    return currentMaxId;
  }
  return store.lastSeenBatchId;
}

export function setWatermark(id: number): void {
  writeStore({ lastSeenBatchId: id });
}
