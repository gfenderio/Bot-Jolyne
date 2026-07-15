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

/**
 * Judul embed ucapan — dipakai untuk MENGENALI ucapan yang sudah terkirim di
 * channel. Harus sama persis dengan default `buildBirthdayNowEmbed()`
 * (src/commands/birthday-now.ts); kalau judulnya diubah di sana tanpa diubah di
 * sini, pengaman anti-dobel ini diam-diam berhenti bekerja.
 */
const BIRTHDAY_EMBED_TITLE = "Birthday Hari Ini";

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

function getDelayUntilNext9amJakarta(now = new Date()) {
  const today = getJakartaDateParts(now);
  // 09:00 WIB besok = 02:00 UTC (WIB = UTC+7, jadi jam UTC = 9 - 7 = 2).
  const next9amUtc = Date.UTC(today.year, today.month - 1, today.day + 1, 2);
  return Math.max(1_000, next9amUtc - now.getTime());
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

/**
 * Ucapan hari ini SUDAH ada di channel?
 *
 * Penanda "sudah dikirim" disimpan di `data/birthday-last-run.json`, dan folder
 * `data/` TIDAK punya volume persisten — jadi tiap redeploy penanda itu hilang,
 * catch-up saat start mengira ucapan hari ini belum terkirim, dan mengirimnya
 * LAGI. Itulah kenapa ucapan yang sama muncul berulang tiap kali bot di-deploy.
 *
 * Obatnya: jangan cuma percaya file yang bisa hilang — tanya Discord-nya
 * langsung. Channel-nya sendiri yang jadi catatan permanen, dan itu tidak ikut
 * terhapus saat redeploy. File-nya tetap dipakai sebagai jalan pintas (biar tak
 * perlu menarik riwayat channel tiap tengah malam), tapi bukan lagi satu-satunya
 * pegangan.
 */
async function announcementAlreadyPosted(
  client: Client<true>,
  channelId: string
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) return false;

    const recent = await channel.messages.fetch({ limit: 30 });
    const todayKey = getJakartaDateKey();

    return recent.some(
      (message) =>
        message.author.id === client.user.id &&
        message.embeds.some((embed) => embed.title === BIRTHDAY_EMBED_TITLE) &&
        getJakartaDateKey(message.createdAt) === todayKey
    );
  } catch (error) {
    // Gagal menarik riwayat (izin kurang / Discord ngambek): JANGAN menganggap
    // "belum terkirim" lalu mengirim ulang — itu justru bug yang mau dibunuh.
    // Lebih baik melewat satu hari daripada membanjiri channel tiap redeploy.
    console.error("Birthday scheduler: gagal cek riwayat channel, kirim dilewati.", error);
    return true;
  }
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

  if (await announcementAlreadyPosted(client, env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID)) {
    console.log("Birthday scheduler: ucapan hari ini sudah ada di channel — tidak dikirim ulang.");
    return true; // true = anggap beres, supaya penandanya ikut ditulis ulang
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
    const delay = getDelayUntilNext9amJakarta();
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
