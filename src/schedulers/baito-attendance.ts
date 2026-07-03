import cron from "node-cron";
import {
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";
import { env } from "../config/env.js";
import { hasAttendedToday } from "../services/baitoAttendanceStore.js";

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

export function startBaitoAttendanceScheduler(client: Client) {
  cron.schedule("0 9 * * *", async () => {
    console.log("Menjalankan jadwal absensi baito jam 09:00 WIB...");
    for (const userId of baitoIds) {
      await sendBaitoAttendanceForm(client, userId).catch(err => console.error("Gagal kirim form absensi ke", userId, err));
    }
  }, { timezone: "Asia/Jakarta" });

  cron.schedule("0,30 9-17 * * *", async () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const h = now.getHours();
    const m = now.getMinutes();
    
    if (h === 9 && m < 10) return;

    for (const userId of baitoIds) {
      if (!hasAttendedToday(userId)) {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) {
          await user.send("⚠️ **Ping!** Kamu belum isi kehadiran hari ini loh, yuk isi sekarang! Cek form di atas ya.").catch(() => null);
        }
      }
    }
  }, { timezone: "Asia/Jakarta" });
}
