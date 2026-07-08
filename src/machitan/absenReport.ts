import ExcelJS from "exceljs";
import type { AbsenBatch, AbsenItem } from "./absenStore.js";

/**
 * Generate output Absen Arrival: dua workbook meniru file contoh
 *  - RES (restock): item ACTION "Cont", per-source di-unpivot jadi baris.
 *      kolom: item_id, source, stock, cogs, opnamed_at, notes
 *  - CONV (convert): item ACTION "Conv", per-source jadi kolom (gamma selalu 0).
 *      kolom: item_id, cogs, price, alpha, ss, omega, beta, sigma, lambda, gamma, barcode, notes
 *
 * KLASIFIKASI PAKAI KOLOM `ACTION`, BUKAN `STATUS`. Di Q2C ada item ber-STATUS
 * "ready" yang tetap masuk CONV (mis. item 210056/210057 di CONV 070726 FAS.xlsx),
 * jadi status bukan penentu. ACTION konsisten di Q2C maupun Q2J:
 *   "Cont 5" → RES · "Conv 10" → CONV · "Led 1 | Conv 9" → CONV
 *   "No Stock" / "Led 2 | No Stock" / kosong → tidak diekspor.
 *
 * Hanya item yang sudah diabsen (done/manual) yang diekspor. Item manual (barcode
 * tak ada di data) dipisah ke workbook MANUAL biar tak mengotori template.
 * Data ditulis polos (values only) supaya gampang copy-paste ke jurnal.
 */

type SourceKey = keyof AbsenItem["alloc"];

const SOURCE_DISPLAY: Record<SourceKey, string> = {
  alpha: "Alpha",
  ss: "SS",
  omega: "Omega",
  beta: "Beta",
  sigma: "Sigma",
  lambda: "Lambda",
  op: "OP",
};

// Urut sesuai kolom sheet; `op` ditaruh terakhir (hanya ada di Q2J).
const SOURCE_ORDER: SourceKey[] = ["alpha", "ss", "omega", "beta", "sigma", "lambda", "op"];

/** "Conv 10" → conv · "Cont 5" → cont · "Led 1 | Conv 9" → conv · lainnya → null. */
export function classifyAction(action: string): "conv" | "cont" | null {
  const a = (action || "").toLowerCase();
  if (a.includes("conv")) return "conv";
  if (a.includes("cont")) return "cont";
  return null;
}

// item_id / barcode angka murni ditulis sebagai number (biar sama dengan contoh).
function numOrStr(v: string): number | string {
  const t = (v ?? "").trim();
  if (t !== "" && /^\d+$/.test(t) && t.length <= 15) return Number(t);
  return t;
}

export interface AbsenExportResult {
  resBuffer: Buffer;
  convBuffer: Buffer;
  manualBuffer: Buffer | null;
  /** Item ber-`Led Qty` > 0. Porsi ledger/PO tak pernah masuk RES/CONV. */
  ledgerBuffer: Buffer | null;
  resRows: number;
  convRows: number;
  manualRows: number;
  ledgerRows: number;
  /** Total pcs ledger di batch ini. */
  ledgerQty: number;
  /** Item sudah diabsen tapi ACTION-nya bukan Cont/Conv (mis. "No Stock") — tidak diekspor. */
  skipped: { itemId: string; name: string; action: string }[];
  /** Anomali: item CONV yang punya alokasi OP. Template CONV tak punya kolom OP. */
  convWithOp: { itemId: string; op: number }[];
}

export async function generateAbsenExport(batch: AbsenBatch): Promise<AbsenExportResult> {
  const notes = `${batch.batchName} - ${batch.dateStr}`;

  // Hanya item yang sudah diabsen.
  const worked = batch.items.filter(
    (it) => it.absenStatus === "done" || it.absenStatus === "manual",
  );
  const manualItems = worked.filter((it) => it.absenStatus === "manual");
  const listedItems = worked.filter((it) => it.absenStatus === "done");

  const convItems: AbsenItem[] = [];
  const resItems: AbsenItem[] = [];
  const skipped: AbsenExportResult["skipped"] = [];
  for (const it of listedItems) {
    const cls = classifyAction(it.action);
    if (cls === "conv") convItems.push(it);
    else if (cls === "cont") resItems.push(it);
    else skipped.push({ itemId: it.itemId, name: it.name, action: it.action });
  }

  // ── RES workbook ─────────────────────────────────────────────────────────
  const resWb = new ExcelJS.Workbook();
  resWb.creator = "Bot Jolyne";
  const resSheet = resWb.addWorksheet("Worksheet");
  resSheet.addRow(["item_id", "source", "stock", "cogs", "opnamed_at", "notes"]);
  let resRows = 0;
  for (const it of resItems) {
    for (const src of SOURCE_ORDER) {
      const qty = it.alloc[src];
      if (!qty || qty <= 0) continue;
      resSheet.addRow([
        numOrStr(it.itemId),
        SOURCE_DISPLAY[src],
        qty,
        it.cogs,
        null,
        notes,
      ]);
      resRows++;
    }
  }
  const resBuffer = Buffer.from(await resWb.xlsx.writeBuffer());

  // ── CONV workbook ────────────────────────────────────────────────────────
  // Template contoh punya 12 kolom tanpa `op`. Sejauh data Q2J, alokasi OP hanya
  // melekat pada item Cont — jadi tak pernah bentrok. Kalau suatu saat bentrok,
  // dicatat di convWithOp dan dilaporkan, BUKAN dibuang diam-diam.
  const convWb = new ExcelJS.Workbook();
  convWb.creator = "Bot Jolyne";
  const convSheet = convWb.addWorksheet("Sheet1");
  convSheet.addRow([
    "item_id", "cogs", "price",
    "alpha", "ss", "omega", "beta", "sigma", "lambda", "gamma",
    "barcode", "notes",
  ]);
  let convRows = 0;
  const convWithOp: AbsenExportResult["convWithOp"] = [];
  for (const it of convItems) {
    if (it.alloc.op > 0) convWithOp.push({ itemId: it.itemId, op: it.alloc.op });
    // Barcode dipakai hanya kalau murni angka. Sheet punya barcode kotor
    // (mis. "6976739639542_1") — output jurnal asli jatuh ke item_id untuk itu.
    const raw = (it.barcode || "").trim();
    const barcode = /^\d+$/.test(raw) ? raw : it.itemId;
    convSheet.addRow([
      numOrStr(it.itemId),
      it.cogs,
      it.readyPrice,
      it.alloc.alpha,
      it.alloc.ss,
      it.alloc.omega,
      it.alloc.beta,
      it.alloc.sigma,
      it.alloc.lambda,
      0, // gamma selalu 0 (digabung ke lambda)
      numOrStr(barcode),
      notes,
    ]);
    convRows++;
  }
  const convBuffer = Buffer.from(await convWb.xlsx.writeBuffer());

  // ── MANUAL workbook (item scan yang tak ada di data) ─────────────────────
  let manualBuffer: Buffer | null = null;
  if (manualItems.length > 0) {
    const mWb = new ExcelJS.Workbook();
    mWb.creator = "Bot Jolyne";
    const mSheet = mWb.addWorksheet("Manual");
    mSheet.addRow(["barcode", "item_id", "name", "qty_datang", "note", "by", "notes"]);
    for (const it of manualItems) {
      mSheet.addRow([
        numOrStr(it.barcode || ""),
        it.itemId ? numOrStr(it.itemId) : "",
        it.name,
        it.qtyDatang ?? 0,
        it.note ?? "",
        it.submittedBy ?? "",
        notes,
      ]);
    }
    manualBuffer = Buffer.from(await mWb.xlsx.writeBuffer());
  }

  // ── LEDGER workbook ──────────────────────────────────────────────────────
  // Porsi ledger/PO tak pernah masuk RES/CONV (kolom ACTION cuma meringkasnya
  // sebagai teks "Led 7 | Conv 13"). Tanpa file ini angkanya hilang sama sekali:
  // item ledger-only cuma terhitung sebagai "skipped", dan pada item campuran
  // porsi ledger-nya tak tercatat di mana pun.
  const ledgerItems = listedItems.filter((it) => it.ledQty > 0);
  const ledgerQty = ledgerItems.reduce((sum, it) => sum + it.ledQty, 0);
  let ledgerBuffer: Buffer | null = null;
  if (ledgerItems.length > 0) {
    const lWb = new ExcelJS.Workbook();
    lWb.creator = "Bot Jolyne";
    const lSheet = lWb.addWorksheet("Ledger");
    lSheet.addRow(["item_id", "barcode", "name", "led_qty", "stock", "action", "notes"]);
    for (const it of ledgerItems) {
      lSheet.addRow([
        numOrStr(it.itemId),
        /^\d+$/.test((it.barcode || "").trim()) ? numOrStr(it.barcode) : "",
        it.name,
        it.ledQty,
        it.stock,
        it.rawAction || it.action,
        notes,
      ]);
    }
    ledgerBuffer = Buffer.from(await lWb.xlsx.writeBuffer());
  }

  return {
    resBuffer,
    convBuffer,
    manualBuffer,
    ledgerBuffer,
    resRows,
    convRows,
    manualRows: manualItems.length,
    ledgerRows: ledgerItems.length,
    ledgerQty,
    skipped,
    convWithOp,
  };
}
