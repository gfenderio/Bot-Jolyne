import fs from "node:fs/promises";
import path from "node:path";

/**
 * Store "Absen Arrival": data absen barang datang yang ditarik dari Google Sheet
 * jurnal (tab PL) lewat Apps Script, dikerjakan di Machitan, lalu di-export jadi
 * RES/CONV xlsx ke Discord.
 *
 * 1 file JSON per batch (data/absen/<id>.json) — supaya scan di batch berbeda tak
 * saling rebutan lock, file tetap kecil, retention gampang. Pola atomic write +
 * withLock sama dengan wsInboxStore.ts / proofStore.ts.
 */

/**
 * Tujuan alokasi — UNION dari kedua sheet jurnal:
 *  - Q2C (China): kolom A, SS, O, B, SG(sigma), L
 *  - Q2J (Japan): kolom A, SS, O, B, OP,       L   ← punya OP, tak punya sigma
 * Lambda menyerap Gamma (1 kota, Surabaya) → kolom gamma di output CONV selalu 0.
 * Kolom yang tak ada di sebuah sheet dikirim 0.
 */
export interface AbsenAlloc {
  alpha: number;
  ss: number;
  omega: number;
  beta: number;
  sigma: number;
  lambda: number;
  /** Area perbaikan/OP. Hanya ada di Q2J; sejauh data, hanya melekat pada item Cont. */
  op: number;
}

export type AbsenItemStatus = "pending" | "done" | "manual";

export interface AbsenItem {
  itemId: string;
  /** Kosong di Q2J (Japan) — sheet itu tak punya kolom Barcode. */
  barcode: string;
  name: string;
  cogs: number;
  readyPrice: number;
  /**
   * Status katalog dari sheet ("ready" | "pre" | "po" | …). JANGAN dipakai untuk
   * memutuskan CONV vs RES — di Q2C ada item `ready` yang masuk CONV. Simpan saja
   * sebagai info; klasifikasi pakai `action`.
   */
  status: string;
  /** Kolom ACTION sheet: "Cont N" → RES, "Conv N" → CONV, "No Stock"/kosong → skip. */
  action: string;
  /** ACTION mentah dari sheet (mis. "Led 7 | Conv 13") — `action` di atas hasil sintesis. */
  rawAction: string;
  /** Kolom "Led Qty": porsi yang masuk ledger/PO, BUKAN stok. Tak ikut RES/CONV. */
  ledQty: number;
  /** Kolom "Stock": porsi yang masuk stok (= total alokasi). */
  stock: number;
  qtyExpected: number;
  alloc: AbsenAlloc;
  sum: number;
  // progres absen
  absenStatus: AbsenItemStatus;
  qtyDatang?: number;
  selisih?: number; // qtyDatang - qtyExpected (flag; 0 = pas)
  note?: string;
  submittedBy?: string;
  submittedAt?: string; // ISO
  // lock kerja-barengan
  lockedBy?: string;
  lockExpiresAt?: string; // ISO
}

export interface AbsenBatch {
  id: string;
  batchName: string;
  dateStr: string; // ddmmyy
  createdAt: string;
  updatedAt: string;
  items: AbsenItem[];
}

export interface AbsenBatchSummary {
  id: string;
  batchName: string;
  dateStr: string;
  createdAt: string;
  updatedAt: string;
  total: number;
  done: number;
  pending: number;
  manual: number;
}

const STORE_DIR = path.join(process.cwd(), "data", "absen");
const LOCK_TTL_MS = 5 * 60 * 1000; // lock item auto-expire 5 menit

// Serialize semua operasi store (global) — konservatif tapi aman & sederhana.
let writeLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function slugifyBatchId(batchName: string): string {
  const slug = batchName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug || "batch";
}

function filePath(id: string): string {
  return path.join(STORE_DIR, `${id}.json`);
}

/**
 * Angka CACAH (qty/alokasi) dibulatkan. Sel sheet kadang menghasilkan float dari
 * formula, dan float di field yang klien harap Int bikin parse JSON-nya gagal
 * total. Nilai UANG (cogs/readyPrice) TIDAK dibulatkan — presisinya dipertahankan.
 */
function count(v: any): number {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function normalizeAlloc(raw: any): AbsenAlloc {
  const n = (v: any) => count(v);
  return {
    alpha: n(raw?.alpha),
    ss: n(raw?.ss),
    omega: n(raw?.omega),
    beta: n(raw?.beta),
    sigma: n(raw?.sigma),
    lambda: n(raw?.lambda),
    op: n(raw?.op),
  };
}

function itemKey(it: { barcode?: string; itemId?: string }): string {
  const bc = (it.barcode || "").trim();
  if (bc) return `bc:${bc}`;
  return `id:${(it.itemId || "").trim()}`;
}

/**
 * Cari item dalam batch lewat barcode atau itemId. Q2J tak punya kolom barcode,
 * jadi item di sana dicari lewat itemId (di Machitan: ketik/cari nama).
 * Barcode/itemId kosong TIDAK boleh cocok dengan key kosong (hindari salah item).
 */
function findItem(batch: AbsenBatch, key: string): AbsenItem | undefined {
  const k = key.trim();
  if (!k) return undefined;
  return batch.items.find(
    (it) => (it.barcode !== "" && it.barcode === k) || (it.itemId !== "" && it.itemId === k),
  );
}

async function readBatchSafe(id: string): Promise<AbsenBatch | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath(id), "utf-8");
  } catch {
    return null;
  }
  if (content.trim() === "") return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? (parsed as AbsenBatch) : null;
  } catch (err) {
    console.error(`absen batch ${id}.json korup:`, err);
    return null;
  }
}

async function writeBatchAtomic(batch: AbsenBatch): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const target = filePath(batch.id);
  const tmpPath = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(batch, null, 2), "utf-8");
  await fs.rename(tmpPath, target);
}

function summarize(batch: AbsenBatch): AbsenBatchSummary {
  let done = 0;
  let pending = 0;
  let manual = 0;
  for (const it of batch.items) {
    if (it.absenStatus === "done") done++;
    else if (it.absenStatus === "manual") manual++;
    else pending++;
  }
  return {
    id: batch.id,
    batchName: batch.batchName,
    dateStr: batch.dateStr,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    total: batch.items.length,
    done,
    pending,
    manual,
  };
}

export interface IntakeItemInput {
  itemId?: string;
  barcode?: string;
  name?: string;
  cogs?: number;
  readyPrice?: number;
  status?: string;
  action?: string;
  rawAction?: string;
  ledQty?: number;
  stock?: number;
  qtyExpected?: number;
  alloc?: Partial<AbsenAlloc>;
  sum?: number;
}

/**
 * Upsert batch dari intake Apps Script. MERGE — progres absen (qtyDatang, note,
 * absenStatus) item yang sudah dikerjakan TIDAK dihapus saat sheet di-push ulang.
 * Field katalog (cogs/price/alloc/status/expected) di-refresh dari payload baru.
 * Item lama yang tak ada di payload baru tetap dipertahankan (jaga progres).
 */
export function upsertBatch(
  batchName: string,
  dateStr: string,
  itemsInput: IntakeItemInput[],
  nowIso: string,
): Promise<AbsenBatchSummary> {
  return withLock(async () => {
    const id = slugifyBatchId(batchName);
    const existing = await readBatchSafe(id);
    const byKey = new Map<string, AbsenItem>();
    if (existing) {
      for (const it of existing.items) byKey.set(itemKey(it), it);
    }

    for (const raw of itemsInput) {
      const key = itemKey(raw);
      const prev = byKey.get(key);
      const catalog = {
        itemId: String(raw.itemId ?? prev?.itemId ?? "").trim(),
        barcode: String(raw.barcode ?? prev?.barcode ?? "").trim(),
        name: String(raw.name ?? prev?.name ?? "Item"),
        cogs: Number(raw.cogs ?? prev?.cogs ?? 0) || 0,
        readyPrice: Number(raw.readyPrice ?? prev?.readyPrice ?? 0) || 0,
        status: String(raw.status ?? prev?.status ?? "").trim().toLowerCase(),
        action: String(raw.action ?? prev?.action ?? "").trim(),
        rawAction: String(raw.rawAction ?? prev?.rawAction ?? "").trim(),
        ledQty: count(raw.ledQty ?? prev?.ledQty),
        stock: count(raw.stock ?? prev?.stock),
        qtyExpected: count(raw.qtyExpected ?? prev?.qtyExpected),
        alloc: normalizeAlloc(raw.alloc ?? prev?.alloc),
        sum: count(raw.sum ?? prev?.sum),
      };
      if (prev) {
        // pertahankan progres absen, refresh katalog
        byKey.set(key, { ...prev, ...catalog });
      } else {
        byKey.set(key, { ...catalog, absenStatus: "pending" });
      }
    }

    const batch: AbsenBatch = {
      id,
      batchName,
      dateStr,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      items: Array.from(byKey.values()),
    };
    await writeBatchAtomic(batch);
    return summarize(batch);
  });
}

export function listBatches(): Promise<AbsenBatchSummary[]> {
  return withLock(async () => {
    let files: string[];
    try {
      files = await fs.readdir(STORE_DIR);
    } catch {
      return [];
    }
    const out: AbsenBatchSummary[] = [];
    for (const f of files) {
      if (!f.endsWith(".json") || f.includes(".tmp")) continue;
      const batch = await readBatchSafe(f.replace(/\.json$/, ""));
      if (batch) out.push(summarize(batch));
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  });
}

export function getBatch(id: string): Promise<AbsenBatch | null> {
  return withLock(() => readBatchSafe(id));
}

export interface SubmitInput {
  qtyDatang: number;
  note?: string;
  actor?: string;
}

/** Konfirmasi jumlah datang untuk satu item. key = barcode atau itemId. */
export function submitItem(
  id: string,
  key: string,
  input: SubmitInput,
  nowIso: string,
): Promise<AbsenItem | null> {
  return withLock(async () => {
    const batch = await readBatchSafe(id);
    if (!batch) return null;
    const item = findItem(batch, key);
    if (!item) return null;
    item.qtyDatang = count(input.qtyDatang);
    item.selisih = item.qtyDatang - item.qtyExpected;
    item.note = input.note ? String(input.note) : item.note;
    item.submittedBy = input.actor ? String(input.actor) : item.submittedBy;
    item.submittedAt = nowIso;
    if (item.absenStatus !== "manual") item.absenStatus = "done";
    // lepas lock setelah submit
    item.lockedBy = undefined;
    item.lockExpiresAt = undefined;
    batch.updatedAt = nowIso;
    await writeBatchAtomic(batch);
    return item;
  });
}

export interface ManualAddInput {
  barcode?: string;
  itemId?: string;
  name?: string;
  qtyDatang: number;
  note?: string;
  actor?: string;
  cogs?: number;
  readyPrice?: number;
  status?: string;
  alloc?: Partial<AbsenAlloc>;
}

/** Barcode yang di-scan tapi tak ada di batch → tambah item manual. */
export function addManualItem(
  id: string,
  input: ManualAddInput,
  nowIso: string,
): Promise<AbsenItem | null> {
  return withLock(async () => {
    const batch = await readBatchSafe(id);
    if (!batch) return null;
    const qty = count(input.qtyDatang);
    const item: AbsenItem = {
      itemId: String(input.itemId ?? "").trim(),
      barcode: String(input.barcode ?? "").trim(),
      name: String(input.name ?? "Item (manual)"),
      cogs: Number(input.cogs ?? 0) || 0,
      readyPrice: Number(input.readyPrice ?? 0) || 0,
      status: String(input.status ?? "").trim().toLowerCase(),
      // Item manual tak punya ACTION dari sheet → tak masuk RES/CONV, hanya file MANUAL.
      action: "",
      rawAction: "",
      ledQty: 0,
      stock: 0,
      qtyExpected: 0,
      alloc: normalizeAlloc(input.alloc),
      sum: qty,
      absenStatus: "manual",
      qtyDatang: qty,
      selisih: qty, // tak ada expected → seluruhnya dianggap "lebih"/manual
      note: input.note ? String(input.note) : undefined,
      submittedBy: input.actor ? String(input.actor) : undefined,
      submittedAt: nowIso,
    };
    batch.items.push(item);
    batch.updatedAt = nowIso;
    await writeBatchAtomic(batch);
    return item;
  });
}

export interface LockResult {
  ok: boolean;
  reason?: string;
  lockedBy?: string;
  lockExpiresAt?: string;
}

/** Lock/unlock item biar tak dobel-garap. action = "lock" | "unlock". */
export function lockItem(
  id: string,
  key: string,
  actor: string,
  action: "lock" | "unlock",
  nowIso: string,
): Promise<LockResult | null> {
  return withLock(async () => {
    const batch = await readBatchSafe(id);
    if (!batch) return null;
    const item = findItem(batch, key);
    if (!item) return null;
    const now = new Date(nowIso).getTime();

    if (action === "unlock") {
      item.lockedBy = undefined;
      item.lockExpiresAt = undefined;
      batch.updatedAt = nowIso;
      await writeBatchAtomic(batch);
      return { ok: true };
    }

    const lockActive =
      item.lockExpiresAt && new Date(item.lockExpiresAt).getTime() > now;
    if (lockActive && item.lockedBy && item.lockedBy !== actor) {
      return { ok: false, reason: "locked", lockedBy: item.lockedBy, lockExpiresAt: item.lockExpiresAt };
    }
    item.lockedBy = actor;
    item.lockExpiresAt = new Date(now + LOCK_TTL_MS).toISOString();
    batch.updatedAt = nowIso;
    await writeBatchAtomic(batch);
    return { ok: true, lockedBy: item.lockedBy, lockExpiresAt: item.lockExpiresAt };
  });
}
