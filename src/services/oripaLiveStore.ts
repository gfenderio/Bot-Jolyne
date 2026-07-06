import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

export type OripaLivePlatform = "ig" | "tiktok";

export type OripaLiveActiveSession = {
  userId: string;
  userTag: string;
  platform: OripaLivePlatform;
  startedAt: string;
  startNote: string;
  startProofUrls: string[];
};

export type OripaLiveInsight = {
  viewers: number | null;
  peakViewers: number | null;
  durationMinutes: number | null;
  comments: number | null;
  likes: number | null;
  shares: number | null;
};

export type OripaLiveSession = OripaLiveActiveSession & {
  endedAt: string;
  durationMinutes: number;
  endNote: string;
  endProofUrls: string[];
  endLink?: string;
  insight?: OripaLiveInsight;
};

type OripaLiveStoreData = {
  active: OripaLiveActiveSession | null;
  sessions: OripaLiveSession[];
};

const STORE_PATH = path.join(process.cwd(), env.ORIPA_LIVE_STORE_PATH ?? "data/oripa-live-sessions.json");

function readStore(): OripaLiveStoreData {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as OripaLiveStoreData;
    return {
      active: parsed.active ?? null,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    };
  } catch {
    return { active: null, sessions: [] };
  }
}

function writeStore(data: OripaLiveStoreData) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf8");
}

export function getActiveLiveSession(): OripaLiveActiveSession | null {
  return readStore().active;
}

export function getCompletedLiveSessions(): OripaLiveSession[] {
  return readStore().sessions;
}

export function startLiveSession(session: OripaLiveActiveSession): void {
  const store = readStore();
  store.active = session;
  writeStore(store);
}

export function endLiveSession(input: {
  endedAt: string;
  endNote: string;
  endProofUrls: string[];
  endLink?: string;
  insight?: OripaLiveInsight;
}): OripaLiveSession | null {
  const store = readStore();

  if (!store.active) {
    return null;
  }

  const startedMs = Date.parse(store.active.startedAt);
  const endedMs = Date.parse(input.endedAt);
  const durationMinutes = Math.max(0, Math.round((endedMs - startedMs) / 60_000));

  const completed: OripaLiveSession = {
    ...store.active,
    endedAt: input.endedAt,
    durationMinutes,
    endNote: input.endNote,
    endProofUrls: input.endProofUrls,
    endLink: input.endLink,
    insight: input.insight
  };

  store.sessions.push(completed);
  store.active = null;
  writeStore(store);

  return completed;
}
