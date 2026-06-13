import fs from "node:fs/promises";
import path from "node:path";

export interface WsInboxProofItem {
  itemId: string;
  productName: string;
  expectedQty: number;
  actualQty: number;
  delta: number;
}

export interface WsInboxProofPayload {
  timestamp: string; // ISO 8601
  actor: string;
  items: WsInboxProofItem[];
  notes?: string;
  isPartial?: boolean;
  pickRequestType?: string;
}

const STORE_PATH = path.join(process.cwd(), "data", "ws-inbox-proofs.json");

async function ensureStoreFile() {
  try {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, "[]", "utf-8");
  }
}

export async function addWsInboxProof(payload: WsInboxProofPayload) {
  await ensureStoreFile();
  const content = await fs.readFile(STORE_PATH, "utf-8");
  const proofs = JSON.parse(content) as WsInboxProofPayload[];
  proofs.push(payload);
  await fs.writeFile(STORE_PATH, JSON.stringify(proofs, null, 2), "utf-8");
}

export async function getAndClearWsInboxProofs(): Promise<WsInboxProofPayload[]> {
  await ensureStoreFile();
  const content = await fs.readFile(STORE_PATH, "utf-8");
  const proofs = JSON.parse(content) as WsInboxProofPayload[];
  await fs.writeFile(STORE_PATH, "[]", "utf-8");
  return proofs;
}
