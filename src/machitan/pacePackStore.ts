import fs from "fs/promises";
import path from "path";

export interface PacePackEvent {
  ts: string;
  actor: string;
  items: number;
  orders: string[];
  bypass: boolean;
}

const STORE_PATH = "data/pace-pack-events.json";

async function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  await fs.mkdir(dir, { recursive: true });
}

export async function addPacePackEvent(event: PacePackEvent): Promise<void> {
  await ensureDir();
  let events: PacePackEvent[] = [];
  try {
    const data = await fs.readFile(STORE_PATH, "utf-8");
    events = JSON.parse(data);
  } catch (e) {
    // Ignore error if file doesn't exist
  }

  events.push(event);

  // Auto-prune older than 120 days
  const now = new Date();
  const threshold = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000);
  events = events.filter((e) => new Date(e.ts) >= threshold);

  await fs.writeFile(STORE_PATH, JSON.stringify(events, null, 2));
}

export async function getPacePackEventsBetween(startISO: string, endISO: string): Promise<PacePackEvent[]> {
  try {
    const data = await fs.readFile(STORE_PATH, "utf-8");
    const events: PacePackEvent[] = JSON.parse(data);
    const start = new Date(startISO);
    const end = new Date(endISO);

    return events.filter((e) => {
      const d = new Date(e.ts);
      return d >= start && d < end;
    });
  } catch (e) {
    return [];
  }
}
