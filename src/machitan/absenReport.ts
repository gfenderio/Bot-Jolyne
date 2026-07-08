import ExcelJS from "exceljs";
import type { AbsenBatch, AbsenItem } from "./absenStore.js";

/**
 * Generate output Absen Arrival: dua workbook meniru file contoh
 *  - RES (restock): item status "ready", per-source di-unpivot jadi baris.
 *      kolom: item_id, source, stock, cogs, opnamed_at, notes
 *  - CONV (convert): item status "pre", per-source jadi kolom (gamma selalu 0).
 *      kolom: item_id, cogs, price, alpha, ss, omega, beta, sigma, lambda, gamma, barcode, notes
 * Hanya item yang sudah diabsen (done/manual) yang diekspor. Item manual
 * (barcode tak ada di data) dipisah ke workbook MANUAL biar tak mengotori template.
 * Data ditulis polos (values only) supaya gampang copy-paste ke jurnal.
 */

const SOURCE_DISPLAY: Record<keyof AbsenItem["alloc"], string> = {
  alpha: "Alpha",
  ss: "SS",
  omega: "Omega",
  beta: "Beta",
  sigma: "Sigma",
  lambda: "Lambda",
};

const SOURCE_ORDER: (keyof AbsenItem["alloc"])[] = [
  "alpha",
  "ss",
  "omega",
  "beta",
  "sigma",
  "lambda",
];

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
  resRows: number;
  convRows: number;
  manualRows: number;
}

export async function generateAbsenExport(batch: AbsenBatch): Promise<AbsenExportResult> {
  const notes = `${batch.batchName} - ${batch.dateStr}`;

  // Hanya item yang sudah diabsen.
  const worked = batch.items.filter(
    (it) => it.absenStatus === "done" || it.absenStatus === "manual",
  );
  const manualItems = worked.filter((it) => it.absenStatus === "manual");
  const listedItems = worked.filter((it) => it.absenStatus === "done");

  const convItems = listedItems.filter((it) => it.status === "pre");
  const resItems = listedItems.filter((it) => it.status !== "pre");

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
  const convWb = new ExcelJS.Workbook();
  convWb.creator = "Bot Jolyne";
  const convSheet = convWb.addWorksheet("Sheet1");
  convSheet.addRow([
    "item_id", "cogs", "price",
    "alpha", "ss", "omega", "beta", "sigma", "lambda", "gamma",
    "barcode", "notes",
  ]);
  let convRows = 0;
  for (const it of convItems) {
    const barcode = (it.barcode || "").trim() || it.itemId;
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

  return {
    resBuffer,
    convBuffer,
    manualBuffer,
    resRows,
    convRows,
    manualRows: manualItems.length,
  };
}
