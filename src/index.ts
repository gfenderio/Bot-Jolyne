import { Client, Events, GatewayIntentBits } from "discord.js";
import { env } from "./config/env.js";
import { handleInteractionCreate } from "./events/interaction-create.js";
import { handleReady } from "./events/ready.js";
import { startMachitanDailyReportScheduler } from "./machitan/dailyReportScheduler.js";
import { registerGuildSlashCommands } from "./services/slash-commands.js";
// Dinonaktifkan — lihat blok ready di bawah.
// import { startNotionStandupScheduler } from "./schedulers/notion-standup.js";
import { startMachitanHttpServer } from "./machitan/httpServer.js";

import { startBaitoAttendanceScheduler } from "./schedulers/baito-attendance.js";
// Dinonaktifkan — lihat blok ready di bawah.
// import { startOripaLiveRecapScheduler } from "./schedulers/oripa-live-recap.js";
import { startPickTriageScheduler } from "./schedulers/pick-triage.js";
import { startSplitPrintScheduler } from "./schedulers/split-print.js";

if (!env.DISCORD_TOKEN) {
  console.warn("DISCORD_TOKEN belum diisi. Discord bot client dilewati.");
} else {
  // Cuma Guilds. Foto "barang rusak" dulu diminta lewat pesan biasa + message
  // collector, yang menuntut intent MessageContent (privileged) — dan kalau
  // intent itu dimatikan di Developer Portal, Discord menolak login dan SELURUH
  // bot mati. Sekarang fotonya diunggah langsung di dalam modal (komponen file
  // upload), jadi intent itu tidak diperlukan lagi. Jangan ditambahkan kembali.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (readyClient) => {
    handleReady(readyClient);
    startMachitanHttpServer(readyClient);
    // Birthday tidak dijadwalkan di sini lagi (21 Sep 2026): hanayo mendorong
    // daftarnya ke POST /hanayo/birthday jam 09:00 WIB.
    startMachitanDailyReportScheduler(readyClient);
    // Dinonaktifkan — tidak dipakai lagi (rekap task Jolyne Tracker ke Discord).
    // startNotionStandupScheduler(readyClient);
    startBaitoAttendanceScheduler(readyClient);
    // Dinonaktifkan — rekap live mingguan tidak perlu cron lagi.
    // startOripaLiveRecapScheduler(readyClient);
    // Digest "Order nyangkut 3-30 hari" DICABUT 17 Sep 2026 — tidak dibaca
    // siapa pun di #pending-shipment, cuma menenggelamkan triase PICK.
    startPickTriageScheduler(readyClient);
    startSplitPrintScheduler(readyClient);
    // Kiriman Rotasi Stok TIDAK dipoll lagi (15 Sep 2026): kakera mendorong
    // kabar dibuat/ditutup ke POST /kakera/wsr-shipment.
  });
  client.on(Events.Error, (error) => {
    console.error("Discord client error", error);
  });
  client.on(Events.InteractionCreate, handleInteractionCreate);

  await registerGuildSlashCommands();

  console.log("Menghubungkan bot ke Discord...");
  await client.login(env.DISCORD_TOKEN);
}
