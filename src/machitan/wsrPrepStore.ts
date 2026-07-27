import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";

/**
 * Catatan "barang mana di sebuah kiriman WSR yang sudah disiapkan gudang, oleh
 * siapa, jam berapa".
 *
 * Kenapa di bot, bukan di tabel wsr_batch_items: keputusan 27 Jul — tidak boleh
 * ada migrasi / perubahan di hanayo. Kolom prepared_by & kawan-kawannya batal,
 * jejaknya ditaruh di sini. Konsekuensi yang harus diingat: laporan di Metabase
 * TIDAK melihat centangan ini; yang kelihatan di database utama tetap cuma hasil
 * akhirnya (stok pindah, executed_by).
 *
 * File tunggal (bukan 1 file per kiriman seperti absenStore): isinya sedikit —
 * beberapa kiriman aktif, masing-masing paling banyak ~200 barang, dan hampir
 * semua akses membaca satu kiriman lalu menulis satu baris centang.
 *
 * Pola tulisnya sama dengan store lain di repo ini: antre lewat withLock, tulis ke
 * file sementara lalu rename (atomic) — mati listrik di tengah tulis tidak
 * meninggalkan JSON separuh yang bikin store hilang seluruhnya.
 */

export interface PrepMark {
  /** Kunci barang di dalam kiriman: itemId + tujuan (satu barang bisa 2 tujuan). */
  key: string;
  itemId: string;
  destination: string;
  by: string;
  at: string;
}

interface PrepBatch {
  /** Hanya barang yang SEDANG tercentang. Dilepas = dihapus dari sini. */
  marks: Record<string, PrepMark>;
  /** Riwayat centang & lepas — inilah "ketrack"-nya, termasuk yang dibatalkan. */
  log: PrepLogEntry[];
  /** Diisi saat kiriman ditutup: apa yang jadi dipindah, apa yang tidak, kenapa. */
  closure?: PrepClosure;
}

/**
 * Catatan penutupan kiriman. Yang dijawab di sini persis pertanyaan orang toko
 * saat barangnya datang kurang: "kok cuma 5, bukan 6 — kenapa?".
 *
 * Barang yang TIDAK jadi dipindah wajib berkeretangan, jadi tidak ada yang
 * hilang tanpa penjelasan. Catatan ini yang dibaca layar Kiriman di PDA.
 */
export interface PrepClosure {
  by: string;
  at: string;
  moved: ClosureItem[];
  skipped: ClosureItem[];
}

export interface ClosureItem {
  itemId: string;
  name: string;
  destination: string;
  qty: number;
  /** Wajib untuk yang tidak jadi dipindah; kosong untuk yang dipindah. */
  reason: string;
}

export interface PrepLogEntry {
  itemId: string;
  destination: string;
  checked: boolean;
  by: string;
  at: string;
}

interface PrepStore {
  batches: Record<string, PrepBatch>;
}

/** Riwayat per kiriman dibatasi supaya file tidak tumbuh tanpa batas. */
const MAX_LOG = 500;

/** Kiriman yang tak tersentuh selama ini dibuang saat store ditulis. */
const RETENTION_DAYS = 60;

let queue: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function storePath(): string {
  return env.WSR_PREP_STORE_PATH;
}

export function prepKey(itemId: string, destination: string): string {
  return `${itemId}|${destination.toUpperCase()}`;
}

async function readStore(): Promise<PrepStore> {
  try {
    const raw = await fs.readFile(storePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.batches !== "object") {
      return { batches: {} };
    }
    return parsed as PrepStore;
  } catch {
    // Belum ada file / isinya rusak: mulai dari kosong. Centangan bukan sumber
    // kebenaran stok — yang hilang paling banter tanda centang, bukan barang.
    return { batches: {} };
  }
}

/** Buang kiriman yang catatan terakhirnya sudah lewat masa simpan. */
function prune(store: PrepStore): PrepStore {
  const batas = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, batch] of Object.entries(store.batches)) {
    const terakhir = batch.log[batch.log.length - 1]?.at;
    if (terakhir && Date.parse(terakhir) < batas) delete store.batches[id];
  }
  return store;
}

async function writeStore(store: PrepStore): Promise<void> {
  const target = storePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(prune(store), null, 2), "utf-8");
  await fs.rename(tmp, target);
}

/** Centangan satu kiriman apa adanya. */
export function getPrep(batchId: number): Promise<PrepMark[]> {
  return withLock(async () => {
    const store = await readStore();
    return Object.values(store.batches[String(batchId)]?.marks ?? {});
  });
}

/** Riwayat centang & lepas satu kiriman, terbaru di belakang. */
export function getPrepLog(batchId: number): Promise<PrepLogEntry[]> {
  return withLock(async () => {
    const store = await readStore();
    return store.batches[String(batchId)]?.log ?? [];
  });
}

/**
 * Centang / lepas satu barang. Balasannya seluruh centangan kiriman itu, supaya
 * PDA tidak perlu menebak keadaan terakhir setelah menekan (dua orang bisa
 * mengerjakan kiriman yang sama berbarengan).
 */
export function setPrep(params: {
  batchId: number;
  itemId: string;
  destination: string;
  checked: boolean;
  by: string;
}): Promise<PrepMark[]> {
  return withLock(async () => {
    const store = await readStore();
    const id = String(params.batchId);
    const batch: PrepBatch = store.batches[id] ?? { marks: {}, log: [] };
    const key = prepKey(params.itemId, params.destination);
    const at = new Date().toISOString();

    if (params.checked) {
      batch.marks[key] = {
        key,
        itemId: params.itemId,
        destination: params.destination.toUpperCase(),
        by: params.by,
        at
      };
    } else {
      delete batch.marks[key];
    }

    batch.log.push({
      itemId: params.itemId,
      destination: params.destination.toUpperCase(),
      checked: params.checked,
      by: params.by,
      at
    });
    if (batch.log.length > MAX_LOG) batch.log = batch.log.slice(-MAX_LOG);

    store.batches[id] = batch;
    await writeStore(store);
    return Object.values(batch.marks);
  });
}

/** Berapa barang tercentang di beberapa kiriman sekaligus — buat layar daftar. */
export function countPrep(batchIds: number[]): Promise<Record<string, number>> {
  return withLock(async () => {
    const store = await readStore();
    const out: Record<string, number> = {};
    for (const id of batchIds) {
      out[String(id)] = Object.keys(store.batches[String(id)]?.marks ?? {}).length;
    }
    return out;
  });
}

/**
 * Simpan catatan penutupan. Ditulis PDA SETELAH stok yang tercentang benar-benar
 * berpindah — bukan sebelum, supaya catatan tidak pernah mengklaim perpindahan
 * yang ternyata gagal.
 */
export function setClosure(batchId: number, closure: PrepClosure): Promise<void> {
  return withLock(async () => {
    const store = await readStore();
    const id = String(batchId);
    const batch: PrepBatch = store.batches[id] ?? { marks: {}, log: [] };
    batch.closure = closure;
    store.batches[id] = batch;
    await writeStore(store);
  });
}

export function getClosure(batchId: number): Promise<PrepClosure | null> {
  return withLock(async () => {
    const store = await readStore();
    return store.batches[String(batchId)]?.closure ?? null;
  });
}

/** Ringkasan penutupan beberapa kiriman — buat baris "5 dari 6" di layar daftar. */
export function closureSummaries(
  batchIds: number[]
): Promise<Record<string, { by: string; at: string; moved: number; skipped: number }>> {
  return withLock(async () => {
    const store = await readStore();
    const out: Record<string, { by: string; at: string; moved: number; skipped: number }> = {};
    for (const id of batchIds) {
      const closure = store.batches[String(id)]?.closure;
      if (!closure) continue;
      out[String(id)] = {
        by: closure.by,
        at: closure.at,
        moved: closure.moved.length,
        skipped: closure.skipped.length
      };
    }
    return out;
  });
}
