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

const baitoIds = env.BAITO_USER_IDS ?? [];

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

  await user.send({ embeds: [embed], components: [attendanceButtons()] });
}

/**
 * Tombol jawaban absensi. Dipakai form pagi DAN pengingat, dengan customId yang
 * sama supaya penanganannya cuma satu (lihat handlers/baitoAttendance.ts).
 */
function attendanceButtons() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("baito_btn_in")
      .setLabel("Masuk")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("baito_btn_out")
      .setLabel("Tidak Masuk")
      .setStyle(ButtonStyle.Danger)
  );
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

  const messages = await (channel as TextChannel).messages.fetch({ limit: 50 });

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

  // Reminder: setiap 30 menit mulai 09:30, berhenti di 11:30.
  cron.schedule("30 9 * * 1-6", () => sendReminders(client), { timezone: "Asia/Jakarta" });
  cron.schedule("0,30 10-11 * * 1-6", () => sendReminders(client), { timezone: "Asia/Jakarta" });

  // Jam 12:00 batas terakhir: yang belum isi diumumkan ke channel absensi.
  cron.schedule("0 12 * * 1-6", () => reportNoResponse(client), { timezone: "Asia/Jakarta" });
}

/**
 * Pengingat membawa tombolnya sendiri, bukan menyuruh "cek form di atas".
 * Form pagi cuma dikirim sekali jam 09:00, jadi siapa pun yang belum punya
 * form di DM-nya — baito yang baru ditambahkan tengah hari, atau semua orang
 * kalau bot kebetulan redeploy setelah jam 09:00 — tetap bisa absen langsung
 * dari pengingat ini.
 */
async function sendReminders(client: Client) {
  for (const userId of baitoIds) {
    const alreadySubmitted = await hasAttendedTodayViaChannel(client, userId);
    if (!alreadySubmitted) {
      const user = await client.users.fetch(userId).catch(() => null);
      if (user) {
        await user.send({
          content: "⚠️ **Ping!** Kamu belum isi kehadiran hari ini loh, yuk isi sekarang lewat tombol di bawah.",
          components: [attendanceButtons()]
        }).catch(() => null);
      }
    }
  }
}

/**
 * Jam 12:00 WIB: kirim satu embed berisi siapa saja yang sampai batas waktu
 * belum mengisi form. Kalau semua sudah isi, tidak ada yang dikirim.
 *
 * Embed ini sengaja TANPA footer "UID: ..." supaya tidak ikut terbaca sebagai
 * bukti kehadiran oleh hasAttendedTodayViaChannel().
 */
async function reportNoResponse(client: Client) {
  const channelId = env.BAITO_ATTENDANCE_CHANNEL_ID;
  if (!channelId) return;

  const belumIsi: string[] = [];
  for (const userId of baitoIds) {
    const alreadySubmitted = await hasAttendedTodayViaChannel(client, userId).catch(() => false);
    if (!alreadySubmitted) belumIsi.push(userId);
  }

  if (belumIsi.length === 0) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) return;

  const embed = new EmbedBuilder()
    .setTitle("⏰ Tidak Ada Respons Absensi")
    .setDescription(
      "Sampai batas waktu **12:00 WIB** orang berikut belum mengisi form kehadiran:\n\n" +
      belumIsi.map(id => `• <@${id}>`).join("\n")
    )
    .setColor(0xffa500)
    .setTimestamp();

  await (channel as TextChannel).send({ embeds: [embed] }).catch(err =>
    console.error("Gagal kirim laporan absensi tidak ada respons", err)
  );
}
