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

async function ensureStoreFile() {
  try {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, "[]", "utf-8");
  }
}

export async function addMachitanProof(payload: MachitanProofPayload) {
  await ensureStoreFile();
  const content = await fs.readFile(STORE_PATH, "utf-8");
  const proofs = JSON.parse(content) as MachitanProofPayload[];
  proofs.push(payload);
  await fs.writeFile(STORE_PATH, JSON.stringify(proofs, null, 2), "utf-8");
}

export async function getAndClearMachitanProofs(): Promise<MachitanProofPayload[]> {
  await ensureStoreFile();
  const content = await fs.readFile(STORE_PATH, "utf-8");
  const proofs = JSON.parse(content) as MachitanProofPayload[];
  await fs.writeFile(STORE_PATH, "[]", "utf-8");
  return proofs;
}
