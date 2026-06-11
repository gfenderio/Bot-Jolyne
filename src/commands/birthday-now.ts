import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { env } from "../config/env.js";
import { fetchAdminBirthdays } from "../services/metabase.js";
import type { SlashCommand } from "../types/command.js";

const JAKARTA_TIME_ZONE = "Asia/Jakarta";

type BirthdayRow = Array<string | number>;

export function hasMetabaseConfig() {
  return Boolean(env.METABASE_URL && env.METABASE_EMAIL && env.METABASE_PASSWORD);
}

function getJakartaToday(now = new Date()) {
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

function parseBirthdateParts(value: string | number | undefined) {
  if (!value) {
    return undefined;
  }

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (!match) {
    return undefined;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function isBirthdayToday(value: string | number | undefined) {
  const today = getJakartaToday();
  const birthdate = parseBirthdateParts(value);

  return Boolean(birthdate && birthdate.month === today.month && birthdate.day === today.day);
}

function calculateAge(value: string | number | undefined) {
  const today = getJakartaToday();
  const birthdate = parseBirthdateParts(value);

  if (!birthdate) {
    return undefined;
  }

  return today.year - birthdate.year;
}

function formatTodayDate() {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "long",
    timeZone: JAKARTA_TIME_ZONE,
    year: "numeric"
  }).format(new Date());
}

export function buildBirthdayNowEmbed(rows: BirthdayRow[], title = "Birthday Hari Ini") {
  if (rows.length === 0) {
    return new EmbedBuilder()
      .setColor(0x8a8f98)
      .setTitle(title)
      .setDescription(`Tidak ada admin yang berulang tahun hari ini, ${formatTodayDate()}.`)
      .setFooter({ text: "Data diambil dari Metabase" })
      .setTimestamp();
  }

  const description = rows.map(([username, name, birthdate], index) => {
    const age = calculateAge(birthdate);
    const ageText = age ? `Berusia ${age} tahun hari ini.` : "Semoga harinya menyenangkan.";

    return [
      `**${index + 1}. Selamat ulang tahun, ${name || "-"}!**`,
      `Username: \`${username || "-"}\``,
      ageText,
      "Semoga sehat, lancar semua urusannya, dan makin sukses."
    ].join("\n");
  }).join("\n\n");

  return new EmbedBuilder()
    .setColor(0xf2c94c)
    .setTitle(title)
    .setDescription(description)
    .setFooter({
      text: `${rows.length} admin berulang tahun hari ini - ${formatTodayDate()}`
    })
    .setTimestamp();
}

function buildTestBirthdayRow(interaction: Parameters<SlashCommand["execute"]>[0]): BirthdayRow {
  const today = getJakartaToday();
  const displayName = interaction.user.globalName ?? interaction.user.username;
  const birthdate = `${today.year - 20}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}T00:00:00+07:00`;

  return [interaction.user.username, displayName, birthdate];
}

export async function fetchTodayBirthdayRows() {
  const dataset = await fetchAdminBirthdays({
    url: env.METABASE_URL!,
    email: env.METABASE_EMAIL!,
    password: env.METABASE_PASSWORD!,
    databaseId: env.METABASE_DATABASE_ID
  });

  return dataset.rows
    .filter(([, , birthdate]) => isBirthdayToday(birthdate))
    .sort((left, right) => String(left[1]).localeCompare(String(right[1]), "id-ID"));
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("birthdaynow")
    .setDescription("Tampilkan admin yang berulang tahun hari ini."),

  async execute(interaction) {
    if (!hasMetabaseConfig()) {
      await interaction.reply({
        content: "Konfigurasi Metabase belum lengkap di `.env`.",
        flags: ["Ephemeral"]
      });
      return;
    }

    await interaction.deferReply({ flags: ["Ephemeral"] });

    const birthdayRows = await fetchTodayBirthdayRows();

    if (birthdayRows.length === 0) {
      await interaction.editReply({
        embeds: [buildBirthdayNowEmbed(birthdayRows)]
      });
      return;
    }

    const channel = await interaction.client.channels.fetch(env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID!);

    if (!channel?.isTextBased() || !("send" in channel)) {
      await interaction.editReply(`Channel ${env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID} tidak bisa dikirimi pesan.`);
      return;
    }

    await channel.send({ embeds: [buildBirthdayNowEmbed(birthdayRows)] });
    await interaction.editReply(`Ucapan birthday hari ini sudah dikirim ke <#${env.BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID}>.`);
  }
};

export const testCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("birthdaynowtest")
    .setDescription("Tes tampilan embed ucapan birthday hari ini."),

  async execute(interaction) {
    const testRows = [buildTestBirthdayRow(interaction)];

    await interaction.reply({
      embeds: [buildBirthdayNowEmbed(testRows, "Birthday Hari Ini - Test")]
    });
  }
};
