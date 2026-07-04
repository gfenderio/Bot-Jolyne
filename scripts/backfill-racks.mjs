#!/usr/bin/env node
/**
 * Backfill rak dari inputan opname PDA (bug SO rak, Jul 2026).
 *
 * Latar: POST /opname/submit backend TIDAK menulis item_stocks.rack_name —
 * rak yang diinput anak WH cuma tercatat di pda_logs. Script ini membaca CSV
 * hasil query Metabase (kolom: item_id,source,rack_opname,rack_sekarang,tgl_opname)
 * lalu menimpa rak via endpoint resmi POST /v2/admin/item/{id}/edit-rack.
 *
 * Pakai:
 *   node scripts/backfill-racks.mjs <path.csv>            # dry-run (default)
 *   node scripts/backfill-racks.mjs <path.csv> --apply    # eksekusi beneran
 *
 * Token: MACHITAN_KYOU_API_TOKEN dari environment / .env di root repo.
 * Output: backfill-racks-result-<timestamp>.csv di folder yang sama dengan input.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "https://api.kyou.id";
const DELAY_MS = 250;

// --- muat .env sederhana (tanpa dependency) ---
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, ".env");
if (!process.env.MACHITAN_KYOU_API_TOKEN && existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const token = process.env.MACHITAN_KYOU_API_TOKEN;
if (!token) {
  console.error("MACHITAN_KYOU_API_TOKEN belum diisi (env / .env).");
  process.exit(1);
}

const csvPath = process.argv[2];
const apply = process.argv.includes("--apply");
if (!csvPath) {
  console.error("Usage: node scripts/backfill-racks.mjs <path.csv> [--apply]");
  process.exit(1);
}

const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
const header = lines[0].split(",").map((h) => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
for (const col of ["item_id", "source", "rack_opname"]) {
  if (!(col in idx)) {
    console.error(`Kolom "${col}" tidak ada di CSV. Header: ${header.join(", ")}`);
    process.exit(1);
  }
}

const rows = lines.slice(1).map((l) => {
  const cells = l.split(",");
  return {
    itemId: cells[idx.item_id]?.trim(),
    source: cells[idx.source]?.trim(),
    rack: cells[idx.rack_opname]?.trim().toUpperCase(),
    current: cells[idx.rack_sekarang]?.trim() ?? "",
  };
}).filter((r) => r.itemId && r.source && r.rack);

console.log(`${rows.length} baris valid dari ${csvPath}`);
console.log(apply ? "MODE: APPLY (menimpa rak beneran)" : "MODE: DRY-RUN (tidak ada yang diubah)");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let ok = 0, fail = 0;

for (const [i, row] of rows.entries()) {
  const label = `[${i + 1}/${rows.length}] item ${row.itemId} ${row.source}: "${row.current}" -> "${row.rack}"`;
  if (!apply) {
    console.log(`DRY ${label}`);
    results.push({ ...row, status: "dry-run", detail: "" });
    continue;
  }
  try {
    const res = await fetch(`${API_BASE}/v2/admin/item/${row.itemId}/edit-rack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-App-Name": "machitan",
      },
      body: JSON.stringify({ source: row.source, rackName: row.rack }),
    });
    const body = await res.text();
    if (res.ok) {
      ok++;
      console.log(`OK  ${label}`);
      results.push({ ...row, status: "ok", detail: "" });
    } else {
      fail++;
      console.error(`ERR ${label} — HTTP ${res.status}: ${body.slice(0, 200)}`);
      results.push({ ...row, status: `http-${res.status}`, detail: body.slice(0, 200).replaceAll(",", ";") });
    }
  } catch (e) {
    fail++;
    console.error(`ERR ${label} — ${e.message}`);
    results.push({ ...row, status: "error", detail: String(e.message).replaceAll(",", ";") });
  }
  await sleep(DELAY_MS);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(dirname(resolve(csvPath)), `backfill-racks-result-${stamp}.csv`);
writeFileSync(
  outPath,
  ["item_id,source,rack_lama,rack_baru,status,detail",
    ...results.map((r) => [r.itemId, r.source, r.current, r.rack, r.status, r.detail ?? ""].join(","))].join("\n"),
  "utf8",
);
console.log(`\nSelesai. OK=${ok} FAIL=${fail} (dry=${results.filter((r) => r.status === "dry-run").length})`);
console.log(`Log hasil: ${outPath}`);
if (fail > 0) process.exitCode = 1;
