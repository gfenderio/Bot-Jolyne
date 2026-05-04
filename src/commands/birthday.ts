import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  SlashCommandBuilder
} from "discord.js";
import { env } from "../config/env.js";
import { fetchAdminBirthdays } from "../services/metabase.js";
import type { SlashCommand } from "../types/command.js";

const PAGE_SIZE = 10;
const JAKARTA_TIME_ZONE = "Asia/Jakarta";

type BirthdayRow = Array<string | number>;

function hasMetabaseConfig() {
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

function getNextBirthdayInfo(value: string | number | undefined, today = getJakartaToday()) {
  const birthdate = parseBirthdateParts(value);

  if (!birthdate) {
    return undefined;
  }

  let nextYear = today.year;
  let nextDate = Date.UTC(nextYear, birthdate.month - 1, birthdate.day);
  const todayDate = Date.UTC(today.year, today.month - 1, today.day);

  if (nextDate < todayDate) {
    nextYear += 1;
    nextDate = Date.UTC(nextYear, birthdate.month - 1, birthdate.day);
  }

  return {
    nextYear,
    daysUntil: Math.round((nextDate - todayDate) / 86_400_000),
    month: birthdate.month,
    day: birthdate.day
  };
}

function sortRowsByUpcomingBirthday(rows: BirthdayRow[], now = new Date()) {
  const today = getJakartaToday(now);

  return [...rows].sort((left, right) => {
    const leftInfo = getNextBirthdayInfo(left[2], today);
    const rightInfo = getNextBirthdayInfo(right[2], today);

    if (!leftInfo && !rightInfo) {
      return String(left[1]).localeCompare(String(right[1]), "id-ID");
    }

    if (!leftInfo) {
      return 1;
    }

    if (!rightInfo) {
      return -1;
    }

    return leftInfo.daysUntil - rightInfo.daysUntil
      || leftInfo.month - rightInfo.month
      || leftInfo.day - rightInfo.day
      || String(left[1]).localeCompare(String(right[1]), "id-ID");
  });
}

function formatBirthdate(value: string | number | undefined) {
  if (!value) {
    return "-";
  }

  const date = new Date(String(value));

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: JAKARTA_TIME_ZONE
  }).format(date);
}

function formatUpcomingBirthday(value: string | number | undefined) {
  const info = getNextBirthdayInfo(value);

  if (!info) {
    return "-";
  }

  const nextDate = new Date(Date.UTC(info.nextYear, info.month - 1, info.day));
  const formattedDate = new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(nextDate);

  if (info.daysUntil === 0) {
    return `${formattedDate} (hari ini)`;
  }

  return `${formattedDate} (${info.daysUntil} hari lagi)`;
}

function buildBirthdayEmbed(rows: BirthdayRow[], page: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const description = pageRows.length === 0
    ? "Tidak ada data admin yang ditemukan."
    : pageRows.map(([username, name, birthdate], index) => {
      const number = start + index + 1;
      return [
        `**${number}. ${name || "-"}**`,
        `Username: \`${username || "-"}\``,
        `Tanggal lahir: ${formatBirthdate(birthdate)}`,
        `Ulang tahun berikutnya: ${formatUpcomingBirthday(birthdate)}`
      ].join("\n");
    }).join("\n\n");

  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle("Daftar Birthday Admin")
    .setDescription(description)
    .setFooter({
      text: `Halaman ${page + 1}/${totalPages} - Total ${rows.length} admin`
    })
    .setTimestamp();
}

function buildBirthdayControls(page: number, rowCount: number) {
  const totalPages = Math.max(1, Math.ceil(rowCount / PAGE_SIZE));

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("birthday:prev")
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId("birthday:next")
      .setLabel("Next")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages - 1)
  );
}

function buildBirthdayMessage(rows: BirthdayRow[], page: number) {
  return {
    embeds: [buildBirthdayEmbed(rows, page)],
    components: [buildBirthdayControls(page, rows.length)]
  };
}

async function handleBirthdayPagination(
  interaction: Parameters<SlashCommand["execute"]>[0],
  rows: BirthdayRow[]
) {
  let page = 0;
  const message = await interaction.editReply(buildBirthdayMessage(rows, page));
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120_000
  });

  collector.on("collect", async (buttonInteraction) => {
    if (buttonInteraction.user.id !== interaction.user.id) {
      await buttonInteraction.reply({
        content: "Pagination ini hanya bisa digunakan oleh pemanggil command.",
        flags: ["Ephemeral"]
      });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

    if (buttonInteraction.customId === "birthday:prev") {
      page = Math.max(0, page - 1);
    }

    if (buttonInteraction.customId === "birthday:next") {
      page = Math.min(totalPages - 1, page + 1);
    }

    await buttonInteraction.update(buildBirthdayMessage(rows, page));
  });

  collector.on("end", async () => {
    await interaction.editReply({
      embeds: [buildBirthdayEmbed(rows, page)],
      components: []
    }).catch(() => undefined);
  });
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("birthday")
    .setDescription("Ambil daftar birthday admin dari Metabase."),

  async execute(interaction) {
    if (!hasMetabaseConfig()) {
      await interaction.reply({
        content: "Konfigurasi Metabase belum lengkap di `.env`.",
        flags: ["Ephemeral"]
      });
      return;
    }

    await interaction.deferReply({ flags: ["Ephemeral"] });

    const dataset = await fetchAdminBirthdays({
      url: env.METABASE_URL!,
      email: env.METABASE_EMAIL!,
      password: env.METABASE_PASSWORD!,
      databaseId: env.METABASE_DATABASE_ID
    });

    await handleBirthdayPagination(interaction, sortRowsByUpcomingBirthday(dataset.rows));
  }
};
