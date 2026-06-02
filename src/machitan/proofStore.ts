import fs from "node:fs/promises";
import path from "node:path";

export interface MachitanProofPayload {
  timestamp: string; // ISO 8601
  channelId: string;
  orderIds: string[];
  actor: string;
  itemSummary: string[];
  itemIds: string[];
  notes: string;
  imageBase64: string;
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
  // Clear file
  await fs.writeFile(STORE_PATH, "[]", "utf-8");
  return proofs;
}
