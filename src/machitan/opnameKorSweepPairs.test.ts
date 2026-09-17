import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpnameKorSweepWorkbook } from "./opnameKorSweepIntake.js";

test("auto-closed pairs get their own sheet, first", () => {
  const workbook = buildOpnameKorSweepWorkbook([], [], "2026-09-18 02:00:00", [], null, [
    { item_id: 102336, kor_source: "SIGMA-KOR", sur_source: "SS-SUR", qty: 2, dasar: "sesama Bekasi" },
  ]);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.name, "Pasangan ditutup otomatis");
  const row = sheet.getRow(2);
  assert.deepEqual([1, 2, 3, 4, 5].map((c) => row.getCell(c).value), [102336, "SIGMA-KOR", "SS-SUR", 2, "sesama Bekasi"]);
});
