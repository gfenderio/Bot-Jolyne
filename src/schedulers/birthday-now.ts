import type { Client } from "discord.js";
import { env } from "../config/env.js";
import { buildBirthdayNowEmbed, fetchTodayBirthdayRows } from "../commands/birthday-now.js";
import { hasKakeraReadConfig } from "../services/kakeraRead.js";

const JAKARTA_TIME_ZONE = "Asia/Jakarta";

/**
 * Judul embed ucapan — dipakai untuk MENGENALI ucapan yang sudah terkirim di
 * channel. Harus sama persis dengan default `buildBirthdayNowEmbed()`
 * (src/commands/birthday-now.ts); kalau judulnya diubah di sana tanpa diubah di
 * sini, pengaman anti-dobel ini diam-diam berhenti bekerja.
 */
const BIRTHDAY_EMBED_TITLE = "Birthday Hari Ini";

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

/**
 * Ucapan hari ini SUDAH ada di channel?
 *
 * Channel-nya sendiri yang jadi catatan — bot tidak punya volume persisten,
 * jadi penanda di berkas hilang tiap redeploy dan dulu membuat ucapan yang sama
 * terkirim berulang.
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

/**
 * Posts today's greeting once. Safe to call repeatedly (startup catch-up, the
 * 09:00 timer, a redeploy mid-morning): the channel check above is the record.
 */
async function announceToday(client: Client<true>) {
  if (!hasKakeraReadConfig()) {
    console.warn("Birthday scheduler: JOLYNE_READ_KEY belum diisi — dilewati.");
    return;
  }

  const birthdayRows = await fetchTodayBirthdayRows();
  if (birthdayRows.length === 0) {
    console.log("Birthday scheduler: tidak ada birthday hari ini.");
    return;
  }

  if (await announcementAlreadyPosted(client, env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID)) {
    console.log("Birthday scheduler: ucapan hari ini sudah ada di channel — tidak dikirim ulang.");
    return;
  }

  const channel = await client.channels.fetch(env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID);
  if (!channel?.isTextBased() || !("send" in channel)) {
    console.error(`Birthday scheduler: channel ${env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID} tidak bisa dikirimi pesan.`);
    return;
  }

  await channel.send({ embeds: [buildBirthdayNowEmbed(birthdayRows)] });
  console.log(`Birthday scheduler: mengirim ${birthdayRows.length} ucapan birthday.`);
}

function getDelayUntilNext9amJakarta(now = new Date()) {
  const today = getJakartaDateParts(now);
  // 09:00 WIB = 02:00 UTC. Today's slot if it is still ahead, else tomorrow's.
  let next = Date.UTC(today.year, today.month - 1, today.day, 2);
  if (next <= now.getTime()) next = Date.UTC(today.year, today.month - 1, today.day + 1, 2);
  return Math.max(1_000, next - now.getTime());
}

function isPast9amJakarta(now = new Date()) {
  const today = getJakartaDateParts(now);
  return now.getTime() >= Date.UTC(today.year, today.month - 1, today.day, 2);
}

export function startBirthdayNowScheduler(client: Client<true>) {
  let timeout: NodeJS.Timeout | undefined;

  const scheduleNextRun = () => {
    timeout = setTimeout(async () => {
      try {
        await announceToday(client);
      } catch (error) {
        console.error("Birthday scheduler failed.", error);
      } finally {
        scheduleNextRun();
      }
    }, getDelayUntilNext9amJakarta());
  };

  // Catch-up for a bot that was down (or redeployed) at 09:00. Before 09:00 it
  // waits for the timer, so a restart at 07:00 does not greet two hours early.
  if (isPast9amJakarta()) {
    announceToday(client).catch((error) => {
      console.error("Birthday scheduler catch-up failed.", error);
    });
  }

  scheduleNextRun();
  console.log(`Birthday scheduler aktif untuk channel ${env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID}.`);

  return () => {
    if (timeout) clearTimeout(timeout);
  };
}
