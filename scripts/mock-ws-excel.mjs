// One-off script: generate mock WS Opname Excel
// Run: node scripts/mock-ws-excel.mjs
import { generateWsReportWorkbook } from "../dist/machitan/dailyReportScheduler.js";
import fs from "node:fs/promises";

const mockProofs = [
  {
    timestamp: "2026-06-16T08:32:11.000Z",
    actor: "Rini Astuti",
    isPartial: false,
    notes: undefined,
    items: [
      { itemId: "10234", productName: "Tumbler Merah Premium 500ml", qtySent: 50, expectedQty: 50, actualQty: 48, selisih: -2, source: "Omega", rack: "A-12" },
      { itemId: "10235", productName: "Tumbler Biru Navy 500ml", qtySent: 30, expectedQty: 30, actualQty: 30, selisih: 0, source: "Omega", rack: "A-13" },
    ],
  },
  {
    timestamp: "2026-06-16T09:15:44.000Z",
    actor: "Budi Santoso",
    isPartial: true,
    notes: "Cek ulang besok, rak bawah belum dihitung",
    items: [
      { itemId: "10891", productName: "Tas Kain Motif Batik Size L", qtySent: 28, expectedQty: 30, actualQty: 35, selisih: 5, source: "SS", rack: "B-04" },
      { itemId: "10892", productName: "Tas Kain Motif Batik Size M", qtySent: 40, expectedQty: 40, actualQty: 38, selisih: -2, source: "SS", rack: "B-04" },
    ],
  },
  {
    timestamp: "2026-06-16T11:44:02.000Z",
    actor: "Eka Purnama",
    isPartial: false,
    notes: undefined,
    items: [
      { itemId: "20011", productName: "Snack Box Coklat Wafer 12pcs", qtySent: 100, expectedQty: 100, actualQty: 100, selisih: 0, source: "Delta", rack: "C-01" },
      { itemId: "20012", productName: "Snack Box Vanilla Wafer 12pcs", qtySent: 80, expectedQty: 80, actualQty: 74, selisih: -6, source: "Delta", rack: "C-02" },
      { itemId: "20013", productName: "Snack Box Stroberi Wafer 12pcs", qtySent: 55, expectedQty: 60, actualQty: 67, selisih: 7, source: "Delta", rack: "C-03" },
    ],
  },
  {
    timestamp: "2026-06-16T14:20:55.000Z",
    actor: "Rini Astuti",
    isPartial: false,
    notes: "Sudah dikonfirmasi supervisor",
    items: [
      { itemId: "10500", productName: "Botol Minum Anak Karakter Doraemon", qtySent: 25, expectedQty: 25, actualQty: 25, selisih: 0, source: "Omega", rack: "A-20" },
    ],
  },
];

const dateStr = "16 Juni 2026";
const buffer = await generateWsReportWorkbook(mockProofs, dateStr);
const outPath = "scripts/Rekap_WS_Opname_Mock_16_Juni_2026_v3.xlsx";
await fs.writeFile(outPath, Buffer.from(buffer));
console.log(`✅ Saved to ${outPath}`);
