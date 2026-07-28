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
  /** Kiriman yang laporan "sudah dikerjakan"-nya sudah dikirim. */
  reported?: number[];
  /**
   * Kiriman yang sudah dapat pengingat susulan. Dicatat supaya pengingatnya
   * SEKALI saja — poller jalan tiap 5 menit, tanpa ini gudang di-tag terus.
   */
  reminded: number[];
}

/** Batas daftar pengingat; kiriman lama tidak perlu diingat selamanya. */
const MAX_REMINDED = 200;

function storePath(): string {
  return env.WSR_SHIPMENT_STORE_PATH;
}

function readStore(): WsrShipmentStore {
  const file = storePath();
  if (!fs.existsSync(file)) return { lastSeenBatchId: null, reminded: [], reported: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const id = Number(parsed.lastSeenBatchId);
    // `reminded` baru ada belakangan — store lama tanpa field itu tetap terbaca.
    const reminded = Array.isArray(parsed.reminded)
      ? parsed.reminded.map(Number).filter(Number.isFinite)
      : [];
    const reported = Array.isArray(parsed.reported)
      ? parsed.reported.map(Number).filter(Number.isFinite)
      : [];
    return { lastSeenBatchId: Number.isFinite(id) ? id : null, reminded, reported };
  } catch {
    return { lastSeenBatchId: null, reminded: [], reported: [] };
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
    writeStore({ ...store, lastSeenBatchId: currentMaxId });
    return currentMaxId;
  }
  return store.lastSeenBatchId;
}

export function setWatermark(id: number): void {
  writeStore({ ...readStore(), lastSeenBatchId: id });
}

/** Kiriman mana saja yang sudah pernah diingatkan. */
export function getReminded(): number[] {
  return readStore().reminded;
}

/** Kiriman mana yang laporan penyelesaiannya sudah dikirim. */
export function getReported(): number[] {
  return readStore().reported ?? [];
}

export function markReported(ids: number[]): void {
  if (ids.length === 0) return;
  const store = readStore();
  const gabungan = [...new Set([...(store.reported ?? []), ...ids])].sort((a, b) => a - b);
  writeStore({ ...store, reported: gabungan.slice(-MAX_REMINDED) });
}

export function markReminded(ids: number[]): void {
  if (ids.length === 0) return;
  const store = readStore();
  const gabungan = [...new Set([...store.reminded, ...ids])].sort((a, b) => a - b);
  writeStore({ ...store, reminded: gabungan.slice(-MAX_REMINDED) });
}
