import ExcelJS from "exceljs";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { getCompletedLiveSessions } from "./oripaLiveStore.js";
import type { OripaLiveSession } from "./oripaLiveStore.js";

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export type OripaLiveRecapPeriod = "minggu-ini" | "bulan-ini" | "bulan-lalu" | "minggu-lalu";

export type OripaLiveRecapRange = {
  label: string;
  startMs: number;
  endMs: number;
};

function wibNowParts(now: Date) {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    // 0 = Minggu ... 6 = Sabtu
    dayOfWeek: shifted.getUTCDay()
  };
}

function wibStartOfDayMs(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day) - WIB_OFFSET_MS;
}

function formatWibDate(ms: number): string {
  return new Date(ms).toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
}

function formatWibDateTime(iso: string): string {
  return new Date(iso).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function wibDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}

export function resolveRecapRange(period: OripaLiveRecapPeriod, now = new Date()): OripaLiveRecapRange {
  const { year, month, day, dayOfWeek } = wibNowParts(now);
  // Senin = awal minggu
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const mondayThisWeekMs = wibStartOfDayMs(year, month, day - daysSinceMonday);

  switch (period) {
    case "minggu-ini":
      return {
        label: `Minggu Ini (${formatWibDate(mondayThisWeekMs)} - ${formatWibDate(now.getTime())})`,
        startMs: mondayThisWeekMs,
        endMs: now.getTime()
      };
    case "minggu-lalu": {
      const mondayLastWeekMs = wibStartOfDayMs(year, month, day - daysSinceMonday - 7);
      return {
        label: `Minggu Lalu (${formatWibDate(mondayLastWeekMs)} - ${formatWibDate(mondayThisWeekMs - 1)})`,
        startMs: mondayLastWeekMs,
        endMs: mondayThisWeekMs
      };
    }
    case "bulan-ini": {
      const firstOfMonthMs = wibStartOfDayMs(year, month, 1);
      return {
        label: `Bulan Ini (${formatWibDate(firstOfMonthMs)} - ${formatWibDate(now.getTime())})`,
        startMs: firstOfMonthMs,
        endMs: now.getTime()
      };
    }
    case "bulan-lalu": {
      const firstOfLastMonthMs = wibStartOfDayMs(year, month - 1, 1);
      const firstOfThisMonthMs = wibStartOfDayMs(year, month, 1);
      return {
        label: `Bulan Lalu (${formatWibDate(firstOfLastMonthMs)} - ${formatWibDate(firstOfThisMonthMs - 1)})`,
        startMs: firstOfLastMonthMs,
        endMs: firstOfThisMonthMs
      };
    }
  }
}

function formatDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes} menit`;
  }

  return `${hours} jam ${minutes} menit`;
}

const PLATFORM_LABELS: Record<OripaLiveSession["platform"], string> = {
  ig: "Instagram",
  tiktok: "TikTok"
};

const ANOMALY_MIN_MINUTES = 15;
const ANOMALY_MAX_MINUTES = 6 * 60;

export type OripaLiveRecapResult = {
  sessionCount: number;
  embed: EmbedBuilder;
  attachment: AttachmentBuilder | null;
};

export async function buildOripaLiveRecap(range: OripaLiveRecapRange): Promise<OripaLiveRecapResult> {
  const sessions = getCompletedLiveSessions()
    .filter((session) => {
      const startedMs = Date.parse(session.startedAt);
      return startedMs >= range.startMs && startedMs < range.endMs;
    })
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  if (sessions.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle(`📊 Rekap Live Oripa — ${range.label}`)
      .setDescription("Tidak ada sesi live yang tercatat pada periode ini.")
      .setColor(0x9e9e9e)
      .setTimestamp();

    return { sessionCount: 0, embed, attachment: null };
  }

  const totalMinutes = sessions.reduce((sum, s) => sum + s.durationMinutes, 0);
  const igSessions = sessions.filter((s) => s.platform === "ig");
  const tiktokSessions = sessions.filter((s) => s.platform === "tiktok");
  const liveDays = new Set(sessions.map((s) => wibDateKey(s.startedAt))).size;
  const avgMinutes = Math.round(totalMinutes / sessions.length);
  const longest = sessions.reduce((a, b) => (b.durationMinutes > a.durationMinutes ? b : a));
  const shortest = sessions.reduce((a, b) => (b.durationMinutes < a.durationMinutes ? b : a));
  const anomalies = sessions.filter(
    (s) => s.durationMinutes < ANOMALY_MIN_MINUTES || s.durationMinutes > ANOMALY_MAX_MINUTES
  );

  const embed = new EmbedBuilder()
    .setTitle(`📊 Rekap Live Oripa — ${range.label}`)
    .setColor(0x1976d2)
    .addFields(
      {
        name: "Total Sesi",
        value: `${sessions.length} sesi (IG: ${igSessions.length}, TikTok: ${tiktokSessions.length})`,
        inline: false
      },
      { name: "Total Jam Live", value: formatDuration(totalMinutes), inline: true },
      { name: "Rata-rata Durasi", value: formatDuration(avgMinutes), inline: true },
      { name: "Hari Ada Live", value: `${liveDays} hari`, inline: true },
      {
        name: "Terpanjang / Terpendek",
        value: `${formatDuration(longest.durationMinutes)} / ${formatDuration(shortest.durationMinutes)}`,
        inline: false
      }
    )
    .setFooter({ text: "Rincian per sesi + link proof ada di file Excel terlampir." })
    .setTimestamp();

  if (anomalies.length > 0) {
    embed.addFields({
      name: "⚠️ Perlu Dicek",
      value: anomalies
        .map(
          (s) =>
            `${formatWibDateTime(s.startedAt)} (${PLATFORM_LABELS[s.platform]}) — durasi ${formatDuration(s.durationMinutes)}`
        )
        .join("\n")
        .slice(0, 1024),
      inline: false
    });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Bot Jolyne";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Rekap Live");
  sheet.columns = [
    { header: "Tanggal", key: "tanggal", width: 16 },
    { header: "Platform", key: "platform", width: 12 },
    { header: "Mulai", key: "mulai", width: 20 },
    { header: "Selesai", key: "selesai", width: 20 },
    { header: "Durasi (menit)", key: "durasi", width: 14 },
    { header: "Keterangan Mulai", key: "noteStart", width: 40 },
    { header: "Keterangan Selesai", key: "noteEnd", width: 40 },
    { header: "Proof Selfie", key: "proofStart", width: 40 },
    { header: "Proof Insight", key: "proofEnd", width: 40 }
  ];
  sheet.getRow(1).font = { bold: true };

  for (const session of sessions) {
    sheet.addRow({
      tanggal: wibDateKey(session.startedAt),
      platform: PLATFORM_LABELS[session.platform],
      mulai: formatWibDateTime(session.startedAt),
      selesai: formatWibDateTime(session.endedAt),
      durasi: session.durationMinutes,
      noteStart: session.startNote,
      noteEnd: session.endNote,
      proofStart: session.startProofUrls[0] ?? "",
      proofEnd: session.endProofUrls[0] ?? ""
    });
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const attachment = new AttachmentBuilder(buffer, {
    name: `Rekap_Live_Oripa_${range.label.split(" (")[0].replace(/ /g, "_")}.xlsx`
  });

  return { sessionCount: sessions.length, embed, attachment };
}
