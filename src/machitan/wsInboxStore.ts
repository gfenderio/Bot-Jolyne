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

// Serialize semua operasi store — sama polanya dengan proofStore.ts
let writeLock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeLock.then(fn, fn);
  writeLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readProofsSafe(): Promise<WsInboxProofPayload[]> {
  let content: string;
  try {
    content = await fs.readFile(STORE_PATH, "utf-8");
  } catch {
    return [];
  }
  if (content.trim() === "") return [];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? (parsed as WsInboxProofPayload[]) : [];
  } catch (err) {
    console.error("ws-inbox-proofs.json korup, di-reset ke []:", err);
    return [];
  }
}

async function writeProofsAtomic(proofs: WsInboxProofPayload[]): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmpPath = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(proofs, null, 2), "utf-8");
  await fs.rename(tmpPath, STORE_PATH);
}

export function addWsInboxProof(payload: WsInboxProofPayload): Promise<void> {
  return withLock(async () => {
    const proofs = await readProofsSafe();
    proofs.push(payload);
    await writeProofsAtomic(proofs);
  });
}

export function getAndClearWsInboxProofs(): Promise<WsInboxProofPayload[]> {
  return withLock(async () => {
    const proofs = await readProofsSafe();
    await writeProofsAtomic([]);
    return proofs;
  });
}
