import cron from "node-cron";
import {
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextChannel
} from "discord.js";
import { env } from "../config/env.js";

const baitoIds = [env.BAITO_REXY_USER_ID, env.BAITO_AZIS_USER_ID].filter(Boolean) as string[];

export async function sendBaitoAttendanceForm(client: Client, userId: string) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;

  const embed = new EmbedBuilder()
    .setTitle("📝 Form Kehadiran Baito")
    .setDescription(
      "Halo! Yuk isi absensi hari ini.\n\n" +
      "**Form kehadiran Baito**\n" +
      "1. Nama\n" +
      "2. Divisi\n" +
      "3. Opsi Masuk / Tidak Masuk\n" +
      "  - *If pilih Masuk*: lanjut isi estimasi jam masuk\n" +
      "  - *If Tidak masuk*: finish tinggal submit"
    )
    .setColor(0x2b2d31);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("baito_btn_in")
      .setLabel("Masuk")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("baito_btn_out")
      .setLabel("Tidak Masuk")
      .setStyle(ButtonStyle.Danger)
  );

  await user.send({ embeds: [embed], components: [row] });
}

/**
 * Cek apakah user sudah submit absensi hari ini dengan membaca
 * pesan di channel #absensi-baito. Cocokkan berdasarkan footer
 * embed yang berisi "UID: <userId>" dan timestamp hari ini (WIB).
 */
async function hasAttendedTodayViaChannel(client: Client, userId: string): Promise<boolean> {
  const channelId = env.BAITO_ATTENDANCE_CHANNEL_ID;
  if (!channelId) return false;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('messages' in channel)) return false;

  const messages = await (channel as TextChannel).messages.fetch({ limit: 20 });

  const nowJakarta = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const todayStr = `${nowJakarta.getFullYear()}-${String(nowJakarta.getMonth() + 1).padStart(2, "0")}-${String(nowJakarta.getDate()).padStart(2, "0")}`;

  return messages.some(msg =>
    msg.embeds.some(embed => {
      const footer = embed.footer?.text || "";
      if (!footer.includes(userId)) return false;

      if (!embed.timestamp) return false;
      const embedJakarta = new Date(new Date(embed.timestamp).toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
      const embedDateStr = `${embedJakarta.getFullYear()}-${String(embedJakarta.getMonth() + 1).padStart(2, "0")}-${String(embedJakarta.getDate()).padStart(2, "0")}`;

      return embedDateStr === todayStr;
    })
  );
}

export function startBaitoAttendanceScheduler(client: Client) {
  cron.schedule("0 9 * * 1-6", async () => {
    console.log("Menjalankan jadwal absensi baito jam 09:00 WIB...");
    for (const userId of baitoIds) {
      await sendBaitoAttendanceForm(client, userId).catch(err => console.error("Gagal kirim form absensi ke", userId, err));
    }
  }, { timezone: "Asia/Jakarta" });

  // Reminder: setiap 30 menit mulai dari 09:30
  cron.schedule("30 9 * * 1-6", () => sendReminders(client), { timezone: "Asia/Jakarta" });
  cron.schedule("0,30 10-17 * * 1-6", () => sendReminders(client), { timezone: "Asia/Jakarta" });
}

async function sendReminders(client: Client) {
  for (const userId of baitoIds) {
    const alreadySubmitted = await hasAttendedTodayViaChannel(client, userId);
    if (!alreadySubmitted) {
      const user = await client.users.fetch(userId).catch(() => null);
      if (user) {
        await user.send("⚠️ **Ping!** Kamu belum isi kehadiran hari ini loh, yuk isi sekarang! Cek form di atas ya.").catch(() => null);
      }
    }
  }
}

