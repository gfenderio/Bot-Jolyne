import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Client } from "discord.js";
import { env } from "../config/env.js";
import {
  buildBirthdayNowEmbed,
  fetchTodayBirthdayRows,
  hasMetabaseConfig
} from "../commands/birthday-now.js";

const JAKARTA_TIME_ZONE = "Asia/Jakarta";
const LAST_RUN_FILE = "data/birthday-last-run.json";

type BirthdaySchedulerState = {
  lastAnnouncementDate?: string;
};

function getJakartaDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: JAKARTA_TIME_ZONE,
    year: "numeric"
  }).formatToParts(now);

  const values = new Map(parts.map((part) => [part.type, part.value]));

  return {
    day: Number(values.get("day")),
    month: Number(values.get("month")),
    year: Number(values.get("year"))
  };
}

function getJakartaDateKey(now = new Date()) {
  const today = getJakartaDateParts(now);
  return [
    today.year,
    String(today.month).padStart(2, "0"),
    String(today.day).padStart(2, "0")
  ].join("-");
}

function getDelayUntilNextJakartaMidnight(now = new Date()) {
  const today = getJakartaDateParts(now);
  const nextMidnightUtc = Date.UTC(today.year, today.month - 1, today.day + 1, -7);
  return Math.max(1_000, nextMidnightUtc - now.getTime());
}

async function readSchedulerState(): Promise<BirthdaySchedulerState> {
  try {
    const content = await readFile(LAST_RUN_FILE, "utf8");
    return JSON.parse(content) as BirthdaySchedulerState;
  } catch {
    return {};
  }
}

async function writeSchedulerState(state: BirthdaySchedulerState) {
  await mkdir(dirname(LAST_RUN_FILE), { recursive: true });
  await writeFile(LAST_RUN_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function sendBirthdayAnnouncement(client: Client<true>) {
  if (!hasMetabaseConfig()) {
    console.warn("Birthday scheduler skipped: konfigurasi Metabase belum lengkap.");
    return false;
  }

  const birthdayRows = await fetchTodayBirthdayRows();

  if (birthdayRows.length === 0) {
    console.log("Birthday scheduler: tidak ada birthday hari ini.");
    return false;
  }

  const channel = await client.channels.fetch(env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID);

  if (!channel?.isTextBased() || !("send" in channel)) {
    console.error(`Birthday scheduler: channel ${env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID} tidak bisa dikirimi pesan.`);
    return false;
  }

  await channel.send({
    embeds: [buildBirthdayNowEmbed(birthdayRows)]
  });

  console.log(`Birthday scheduler: mengirim ${birthdayRows.length} ucapan birthday.`);
  return true;
}

async function runBirthdayAnnouncementOncePerDay(client: Client<true>) {
  const todayKey = getJakartaDateKey();
  const state = await readSchedulerState();

  if (state.lastAnnouncementDate === todayKey) {
    console.log(`Birthday scheduler: announcement ${todayKey} sudah pernah dikirim.`);
    return;
  }

  const sent = await sendBirthdayAnnouncement(client);

  if (sent) {
    await writeSchedulerState({
      lastAnnouncementDate: todayKey
    });
  }
}

export function startBirthdayNowScheduler(client: Client<true>) {
  let timeout: NodeJS.Timeout | undefined;

  const scheduleNextRun = () => {
    const delay = getDelayUntilNextJakartaMidnight();
    timeout = setTimeout(async () => {
      try {
        await runBirthdayAnnouncementOncePerDay(client);
      } catch (error) {
        console.error("Birthday scheduler failed.", error);
      } finally {
        scheduleNextRun();
      }
    }, delay);
  };

  runBirthdayAnnouncementOncePerDay(client).catch((error) => {
    console.error("Birthday scheduler catch-up failed.", error);
  });

  scheduleNextRun();
  console.log(`Birthday scheduler aktif untuk channel ${env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID}.`);

  return () => {
    if (timeout) {
      clearTimeout(timeout);
    }
  };
}
