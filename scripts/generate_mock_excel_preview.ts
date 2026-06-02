import fs from "node:fs/promises";
import path from "node:path";
import { generateMachitanReportWorkbook } from "../src/machitan/dailyReportScheduler.js";
import type { MachitanProofPayload } from "../src/machitan/proofStore.js";

const PICK_FISIK_CHANNEL = "1390221553333043200";
const MARK_PICK_CHANNEL = "1418827227264450663";
const PACK_PROOF_CHANNEL = "1209860901914677368";

function mkIso(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const proofs: MachitanProofPayload[] = [
  // ───────── PICK FISIK — E-COM (with image proof) ─────────
  {
    timestamp: mkIso(9, 14),
    channelId: PICK_FISIK_CHANNEL,
    orderIds: ["INV/20260602/MPL/12345678"],
    actor: "Farhan Wirayudha",
    notes: "Order Shopee priority.",
    imageBase64: "",
    proofType: "ECOM_PHYSICAL_PICK_PROOF",
    items: [
      {
        orderId: "INV/20260602/MPL/12345678",
        orderItemId: "2000000081",
        itemId: "39125",
        productName: "Blue Archive Trinity Chocopuni Plushie Iochi Mari (17cm)",
        qty: 1,
        source: "ALPHA",
        channel: "Shopee",
        invoiceNumber: "INV/20260602/MPL/12345678",
        originType: "ecommerce_outside",
      },
    ],
  },
  {
    timestamp: mkIso(10, 32),
    channelId: PICK_FISIK_CHANNEL,
    orderIds: ["TOKO-9988776655"],
    actor: "Rizky Pratama",
    notes: "Bonus pin included.",
    imageBase64: "",
    proofType: "ECOM_PHYSICAL_PICK_PROOF",
    items: [
      {
        orderId: "TOKO-9988776655",
        orderItemId: "2000000099",
        itemId: "41203",
        productName: "Hololive Pekora Acrylic Stand Edisi Ulang Tahun",
        qty: 2,
        source: "OMEGA",
        channel: "Tokopedia",
        invoiceNumber: "TOKO-9988776655",
        originType: "ecommerce_outside",
      },
    ],
  },

  // ───────── PICK FISIK — Regular / B2B / UReq / Gift (logOnly) ─────────
  {
    timestamp: mkIso(8, 5),
    channelId: PICK_FISIK_CHANNEL,
    orderIds: ["376901"],
    actor: "Farhan Wirayudha",
    notes: "Pick Fisik via PDA (auto-log, source: ALPHA)",
    imageBase64: "",
    proofType: "PICK_FISIK_LOG",
    items: [
      {
        orderId: "376901",
        orderItemId: "412300",
        itemId: "38211",
        productName: "Genshin Impact Hu Tao Nendoroid",
        qty: 1,
        source: "ALPHA",
        rackName: "A1-03",
      },
    ],
  },
  {
    timestamp: mkIso(8, 22),
    channelId: PICK_FISIK_CHANNEL,
    orderIds: ["376902"],
    actor: "Indah Pertiwi",
    notes: "Pick Fisik via PDA (auto-log, source: OMEGA)",
    imageBase64: "",
    proofType: "PICK_FISIK_LOG",
    items: [
      {
        orderId: "376902",
        orderItemId: "412301",
        itemId: "27890",
        productName: "Sword Art Online Alicization Art Book",
        qty: 1,
        source: "OMEGA",
        rackName: "B2-12",
      },
      {
        orderId: "376902",
        orderItemId: "412302",
        itemId: "30115",
        productName: "Re:Zero Rem Figure 1/7 Scale GSC",
        qty: 1,
        source: "OMEGA",
        rackName: "B2-15",
      },
    ],
  },
  // UReq sample
  {
    timestamp: mkIso(11, 47),
    channelId: PICK_FISIK_CHANNEL,
    orderIds: ["377097"],
    actor: "Bayu Setiawan",
    notes: "Pick Fisik via PDA (auto-log, source: UREQ)",
    imageBase64: "",
    proofType: "PICK_FISIK_LOG",
    items: [
      {
        orderId: "377097",
        orderItemId: "1000039219",
        itemId: "-",
        productName: "Hotwheels metal parts (UReq)",
        qty: 1,
        source: "UREQ",
      },
    ],
  },
  // Gift Redeem sample
  {
    timestamp: mkIso(13, 30),
    channelId: PICK_FISIK_CHANNEL,
    orderIds: ["400123"],
    actor: "Dewi Lestari",
    notes: "Pick Fisik via PDA (auto-log, source: GIFT)",
    imageBase64: "",
    proofType: "PICK_FISIK_LOG",
    items: [
      {
        orderId: "400123",
        orderItemId: "400123",
        itemId: "99999",
        productName: "Gift Item Kyou — Tote Bag Edisi Spesial",
        qty: 1,
        source: "GIFT",
      },
    ],
  },

  // ───────── MARK PICK ─────────
  {
    timestamp: mkIso(9, 48),
    channelId: MARK_PICK_CHANNEL,
    orderIds: ["376501", "376502"],
    actor: "Farhan Wirayudha",
    notes: "Mark Pick batch 5 item.",
    imageBase64: "",
    proofType: "PICK_PROOF",
    items: [
      {
        orderId: "376501",
        orderItemId: "411001",
        itemId: "12345",
        productName: "One Piece Luffy Gear 5 Statue",
        qty: 1,
        source: "REGULAR",
        originType: "REGULAR",
      },
      {
        orderId: "376501",
        orderItemId: "411002",
        itemId: "12346",
        productName: "One Piece Zoro Statue",
        qty: 1,
        source: "REGULAR",
      },
      {
        orderId: "376502",
        orderItemId: "411003",
        itemId: "98765",
        productName: "B2B Partner Bulk Order — Comic Set Boruto",
        qty: 5,
        source: "B2B",
        originType: "B2B",
      },
    ],
  },
  {
    timestamp: mkIso(14, 15),
    channelId: MARK_PICK_CHANNEL,
    orderIds: ["376511"],
    actor: "Rizky Pratama",
    notes: "Mark Pick UReq via PDA.",
    imageBase64: "",
    proofType: "PICK_PROOF",
    items: [
      {
        orderId: "376511",
        orderItemId: "1000039501",
        itemId: "-",
        productName: "UReq Special Order — Dragon Ball Z Volume 1 (Jump Comics)",
        qty: 1,
        source: "UREQ",
        originType: "ureq",
      },
    ],
  },

  // ───────── PACK ─────────
  {
    timestamp: mkIso(15, 5),
    channelId: PACK_PROOF_CHANNEL,
    orderIds: ["376439"],
    actor: "Maman Suparman",
    notes: "Pack normal di BEKASI.",
    imageBase64: "",
    proofType: "PACK_PROOF",
    items: [
      {
        orderId: "376439",
        orderItemId: "411500",
        itemId: "55677",
        productName: "Chainsaw Man Power Plush 30cm",
        qty: 1,
        source: "BEKASI",
        packLocation: "BEKASI",
        rackName: "C4-02",
      },
      {
        orderId: "376439",
        orderItemId: "1000039219",
        itemId: "-",
        productName: "UReq Pack — Hotwheels metal parts",
        qty: 1,
        source: "UREQ",
        packLocation: "BEKASI",
      },
    ],
  },
  {
    timestamp: mkIso(16, 40),
    channelId: PACK_PROOF_CHANNEL,
    orderIds: ["376802"],
    actor: "Indah Pertiwi",
    notes: "Pack normal Tangerang.",
    imageBase64: "",
    proofType: "PACK_PROOF",
    items: [
      {
        orderId: "376802",
        orderItemId: "412100",
        itemId: "66112",
        productName: "Spy x Family Anya Figure (Banpresto)",
        qty: 3,
        source: "TANGERANG",
        packLocation: "TANGERANG",
        rackName: "T1-08",
      },
    ],
  },
  // ───────── ARCHIVE LOG (per-source archive) ─────────
  {
    timestamp: mkIso(8, 12),
    channelId: PICK_FISIK_CHANNEL,
    orderIds: ["376988"],
    actor: "Farhan Wirayudha",
    notes: "Archive: Barang tidak ketemu",
    imageBase64: "",
    proofType: "PICK_ARCHIVE",
    items: [
      {
        orderId: "376988",
        orderItemId: "412600",
        itemId: "44211",
        productName: "Demon Slayer Tanjiro Statue (data corrupt)",
        qty: 1,
        source: "ALPHA",
        rackName: "A3-07",
        archiveReason: "Barang tidak ketemu",
      },
    ],
  },
  {
    timestamp: mkIso(10, 5),
    channelId: PICK_FISIK_CHANNEL,
    orderIds: ["376989"],
    actor: "Indah Pertiwi",
    notes: "Archive: Sudah pindah rak",
    imageBase64: "",
    proofType: "PICK_ARCHIVE",
    items: [
      {
        orderId: "376989",
        orderItemId: "412601",
        itemId: "44512",
        productName: "Jujutsu Kaisen Itadori Acrylic Stand",
        qty: 1,
        source: "OMEGA",
        rackName: "B1-04",
        archiveReason: "Sudah pindah rak",
      },
    ],
  },
  {
    timestamp: mkIso(11, 30),
    channelId: PICK_FISIK_CHANNEL,
    orderIds: ["376990"],
    actor: "Bayu Setiawan",
    notes: "Archive: Data salah",
    imageBase64: "",
    proofType: "PICK_ARCHIVE",
    items: [
      {
        orderId: "376990",
        orderItemId: "412602",
        itemId: "-",
        productName: "Item UReq tidak valid",
        qty: 1,
        source: "UREQ",
        archiveReason: "Data salah",
      },
    ],
  },

  // E-Commerce Pack
  {
    timestamp: mkIso(17, 20),
    channelId: PACK_PROOF_CHANNEL,
    orderIds: ["INV/20260602/MPL/12345678"],
    actor: "Maman Suparman",
    notes: "Pack E-COM Shopee.",
    imageBase64: "",
    proofType: "PACK_PROOF",
    items: [
      {
        orderId: "INV/20260602/MPL/12345678",
        orderItemId: "2000000081",
        itemId: "39125",
        productName: "Blue Archive Trinity Chocopuni Plushie Iochi Mari (17cm)",
        qty: 1,
        source: "BEKASI",
        packLocation: "BEKASI",
        rackName: "P-EC-01",
        channel: "Shopee",
        invoiceNumber: "INV/20260602/MPL/12345678",
      },
    ],
  },
];

async function main() {
  const todayStr = new Date().toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const { buffer, pickFisiks, markPicks, packProofs, archives } = await generateMachitanReportWorkbook(proofs, todayStr);

  const outDir = path.join(process.cwd(), "scratch");
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `Rekap_Warehouse_PREVIEW_${todayStr.replace(/ /g, "_")}.xlsx`);
  await fs.writeFile(outFile, Buffer.from(buffer));

  const downloadsPath = path.join(process.env.USERPROFILE ?? "C:\\Users\\PCServer-Kyou", "Downloads");
  try {
    await fs.access(downloadsPath);
    const downloadsCopy = path.join(downloadsPath, `Rekap_Warehouse_PREVIEW_${todayStr.replace(/ /g, "_")}.xlsx`);
    await fs.writeFile(downloadsCopy, Buffer.from(buffer));
    console.log(`✅ Mock Excel preview written:\n  ${outFile}\n  ${downloadsCopy}\n`);
  } catch {
    console.log(`✅ Mock Excel preview written:\n  ${outFile}\n`);
  }

  console.log("Stats:");
  console.log(`  Pick Fisik proofs : ${pickFisiks.length}`);
  console.log(`  Mark Pick proofs  : ${markPicks.length}`);
  console.log(`  Pack proofs       : ${packProofs.length}`);
  console.log(`  Archive entries   : ${archives.length}`);
  const totalItems = proofs.reduce((sum, p) => sum + (Array.isArray(p.items) ? p.items.length : 0), 0);
  console.log(`  Total item rows   : ${totalItems}`);
}

main().catch((err) => {
  console.error("Failed to generate mock Excel:", err);
  process.exit(1);
});
