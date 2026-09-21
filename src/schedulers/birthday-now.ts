import type { Client } from "discord.js";
import { env } from "../config/env.js";
import { buildBirthdayNowEmbed } from "../commands/birthday-now.js";

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
 * terkirim berulang. Ini juga yang membuat hanayo aman mengirim ulang.
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

export type BirthdayPerson = {
  username: string;
  name: string;
  birthdate: string;
};

export type BirthdayAnnounceResult = "sent" | "already-posted" | "empty" | "wrong-date" | "no-channel";

/**
 * Posts today's greeting from a list pushed by hanayo (`jolyne:birthday`, 09:00 WIB).
 *
 * The bot used to fetch this list from Metabase on its own schedule. Metabase
 * started rejecting the bot's login on 21 Sep 2026 and the greeting stopped
 * without a trace, so hanayo now reads the database and sends the list here.
 */
export async function announceBirthdays(
  client: Client<true>,
  date: string,
  people: BirthdayPerson[]
): Promise<BirthdayAnnounceResult> {
  // A retry that arrives after midnight must not greet yesterday's people "today".
  if (date !== getJakartaDateKey()) return "wrong-date";
  if (people.length === 0) return "empty";

  if (await announcementAlreadyPosted(client, env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID)) {
    console.log("Birthday: ucapan hari ini sudah ada di channel — tidak dikirim ulang.");
    return "already-posted";
  }

  const channel = await client.channels.fetch(env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID);
  if (!channel?.isTextBased() || !("send" in channel)) {
    console.error(`Birthday: channel ${env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID} tidak bisa dikirimi pesan.`);
    return "no-channel";
  }

  const rows = people.map((person) => [person.username, person.name, person.birthdate]);
  await channel.send({ embeds: [buildBirthdayNowEmbed(rows)] });
  console.log(`Birthday: mengirim ${people.length} ucapan birthday.`);
  return "sent";
}
