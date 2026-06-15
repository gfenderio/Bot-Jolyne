import fs from "node:fs/promises";
import path from "node:path";

export interface MachitanProofItem {
  orderId?: string;
  orderItemId?: string;
  itemId?: string;
  productName: string;
  qty: number;
  source: string;
  channel?: string;
  invoiceNumber?: string;
  originType?: string;
  packLocation?: string;
  rackName?: string;
  archiveReason?: string;
}

export interface MachitanProofPayload {
  timestamp: string; // ISO 8601
  channelId: string;
  orderIds: string[];
  actor: string;
  items: MachitanProofItem[];
  notes: string;
  imageBase64: string;
  proofType?: string; // PICK_PROOF / PACK_PROOF / PACK_PROOF_BYPASS / ECOM_PHYSICAL_PICK_PROOF
  isBypass?: boolean;
  bypassReason?: string;
}

const STORE_PATH = path.join(process.cwd(), "data", "machitan-proofs.json");

// Serialize semua operasi store agar read-modify-write tidak balapan
// (2 proof masuk bersamaan bisa saling timpa / mengosongkan file).
let writeLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  // Jaga rantai tetap hidup walau fn melempar.
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Baca store dengan toleransi: file hilang / kosong / korup dianggap array kosong,
// jangan sampai JSON.parse melempar "Unexpected end of JSON input".
async function readProofsSafe(): Promise<MachitanProofPayload[]> {
  let content: string;
  try {
    content = await fs.readFile(STORE_PATH, "utf-8");
  } catch {
    return [];
  }
  if (content.trim() === "") return [];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? (parsed as MachitanProofPayload[]) : [];
  } catch (err) {
    console.error("machitan-proofs.json korup, di-reset ke []:", err);
    return [];
  }
}

// Tulis atomik: tulis ke file sementara lalu rename, agar file utama tidak pernah
// dalam keadaan setengah-ketulis kalau proses mati di tengah jalan.
async function writeProofsAtomic(proofs: MachitanProofPayload[]): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmpPath = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(proofs, null, 2), "utf-8");
  await fs.rename(tmpPath, STORE_PATH);
}

export function addMachitanProof(payload: MachitanProofPayload): Promise<void> {
  return withLock(async () => {
    const proofs = await readProofsSafe();
    proofs.push(payload);
    await writeProofsAtomic(proofs);
  });
}

export function getAndClearMachitanProofs(): Promise<MachitanProofPayload[]> {
  return withLock(async () => {
    const proofs = await readProofsSafe();
    await writeProofsAtomic([]);
    return proofs;
  });
}
