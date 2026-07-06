import path from "node:path";
import {
  AttachmentBuilder,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  RadioGroupBuilder,
  RadioGroupOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import type { Attachment, ModalSubmitInteraction } from "discord.js";
import { env } from "../config/env.js";
import {
  endLiveSession,
  getActiveLiveSession,
  startLiveSession
} from "../services/oripaLiveStore.js";
import type { OripaLivePlatform } from "../services/oripaLiveStore.js";

export const ORIPA_LIVE_START_MODAL_ID = "oripa_live_modal_start";
export const ORIPA_LIVE_END_MODAL_ID = "oripa_live_modal_end";

const PLATFORM_LABELS: Record<OripaLivePlatform, string> = {
  ig: "Instagram",
  tiktok: "TikTok"
};

const PLATFORM_COLORS: Record<OripaLivePlatform, number> = {
  ig: 0xe1306c,
  tiktok: 0x69c9d0
};

export function isOripaLiveUserAllowed(userId: string): boolean {
  return (env.ORIPA_LIVE_ALLOWED_USER_IDS ?? []).includes(userId);
}

export function buildOripaLiveStartModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(ORIPA_LIVE_START_MODAL_ID)
    .setTitle("Mulai Live Oripa")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Platform live")
        .setRadioGroupComponent(
          new RadioGroupBuilder()
            .setCustomId("live_platform")
            .addOptions(
              new RadioGroupOptionBuilder().setLabel("Instagram").setValue("ig"),
              new RadioGroupOptionBuilder().setLabel("TikTok").setValue("tiktok")
            )
        ),
      new LabelBuilder()
        .setLabel("Foto selfie dengan timestamp")
        .setDescription("Selfie sebelum mulai live, pakai kamera timestamp.")
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId("live_proof")
            .setRequired(true)
            .setMaxValues(1)
        ),
      new LabelBuilder()
        .setLabel("Keterangan")
        .setDescription("Contoh: live oripa seri X, target 2 jam.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("live_note")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500)
        )
    );
}

export function buildOripaLiveEndModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(ORIPA_LIVE_END_MODAL_ID)
    .setTitle("Selesai Live Oripa")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Foto insight live")
        .setDescription("Screenshot ringkasan/insight setelah live selesai.")
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId("live_proof")
            .setRequired(true)
            .setMaxValues(1)
        ),
      new LabelBuilder()
        .setLabel("Link live/replay (opsional)")
        .setDescription("Contoh: link replay TikTok atau link live IG.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("live_link")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(300)
        ),
      new LabelBuilder()
        .setLabel("Keterangan")
        .setDescription("Contoh: total penonton, hasil penjualan, kendala.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("live_note")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500)
        )
    );
}

function toProofAttachment(attachment: Attachment, baseName: string): AttachmentBuilder {
  const ext = path.extname(attachment.name ?? "") || ".png";
  return new AttachmentBuilder(attachment.url, { name: `${baseName}${ext}` });
}

function discordTimestamp(iso: string): string {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:f>`;
}

function formatDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes} menit`;
  }

  return `${hours} jam ${minutes} menit`;
}

async function sendToLiveChannel(
  interaction: ModalSubmitInteraction,
  payload: { embeds: EmbedBuilder[]; files: AttachmentBuilder[] }
) {
  const channelId = env.ORIPA_LIVE_CHANNEL_ID;

  if (!channelId) {
    throw new Error("ORIPA_LIVE_CHANNEL_ID belum diset.");
  }

  const channel = await interaction.client.channels.fetch(channelId);

  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`Channel ${channelId} tidak bisa dikirimi pesan.`);
  }

  await channel.send(payload);
}

export async function handleOripaLiveModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!isOripaLiveUserAllowed(interaction.user.id)) {
    await interaction.editReply("❌ Kamu tidak memiliki izin untuk laporan live oripa.");
    return;
  }

  const note = interaction.fields.getTextInputValue("live_note");
  const uploads = interaction.fields.getUploadedFiles("live_proof", true);
  const proof = uploads.first();

  if (!proof) {
    await interaction.editReply("❌ Foto proof tidak terbaca. Coba ulangi.");
    return;
  }

  try {
    if (interaction.customId === ORIPA_LIVE_START_MODAL_ID) {
      const existing = getActiveLiveSession();

      if (existing) {
        await interaction.editReply(
          `⚠️ Masih ada sesi live ${PLATFORM_LABELS[existing.platform]} yang belum ditutup (mulai ${discordTimestamp(existing.startedAt)}). Tutup dulu dengan \`/live end\`.`
        );
        return;
      }

      const platform = interaction.fields.getRadioGroup("live_platform", true) as OripaLivePlatform;
      const startedAt = new Date().toISOString();

      startLiveSession({
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        platform,
        startedAt,
        startNote: note,
        startProofUrls: [proof.url]
      });

      const file = toProofAttachment(proof, "live-start-proof");
      const embed = new EmbedBuilder()
        .setTitle(`🔴 Live Dimulai — ${PLATFORM_LABELS[platform]}`)
        .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
        .addFields(
          { name: "Platform", value: PLATFORM_LABELS[platform], inline: true },
          { name: "Jam Mulai", value: discordTimestamp(startedAt), inline: true },
          { name: "Keterangan", value: note, inline: false }
        )
        .setImage(`attachment://${file.name}`)
        .setColor(PLATFORM_COLORS[platform])
        .setFooter({ text: `UID: ${interaction.user.id}` })
        .setTimestamp();

      await sendToLiveChannel(interaction, { embeds: [embed], files: [file] });
      await interaction.editReply(
        `✅ Sesi live ${PLATFORM_LABELS[platform]} dicatat mulai ${discordTimestamp(startedAt)}. Jangan lupa \`/live end\` setelah selesai.`
      );
      return;
    }

    if (interaction.customId === ORIPA_LIVE_END_MODAL_ID) {
      const endedAt = new Date().toISOString();
      const link = interaction.fields.getTextInputValue("live_link").trim();
      const completed = endLiveSession({
        endedAt,
        endNote: note,
        endProofUrls: [proof.url],
        endLink: link || undefined
      });

      if (!completed) {
        await interaction.editReply("⚠️ Tidak ada sesi live yang sedang berjalan. Mulai dulu dengan `/live start`.");
        return;
      }

      const file = toProofAttachment(proof, "live-end-insight");
      const embed = new EmbedBuilder()
        .setTitle(`⏹️ Live Selesai — ${PLATFORM_LABELS[completed.platform]}`)
        .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
        .addFields(
          { name: "Platform", value: PLATFORM_LABELS[completed.platform], inline: true },
          { name: "Jam Mulai", value: discordTimestamp(completed.startedAt), inline: true },
          { name: "Jam Selesai", value: discordTimestamp(completed.endedAt), inline: true },
          { name: "Durasi", value: formatDuration(completed.durationMinutes), inline: true },
          ...(completed.endLink ? [{ name: "Link", value: completed.endLink, inline: false }] : []),
          { name: "Keterangan", value: note, inline: false }
        )
        .setImage(`attachment://${file.name}`)
        .setColor(PLATFORM_COLORS[completed.platform])
        .setFooter({ text: `UID: ${interaction.user.id}` })
        .setTimestamp();

      await sendToLiveChannel(interaction, { embeds: [embed], files: [file] });
      await interaction.editReply(
        `✅ Sesi live ${PLATFORM_LABELS[completed.platform]} ditutup. Durasi: ${formatDuration(completed.durationMinutes)}.`
      );
      return;
    }
  } catch (error) {
    console.error("Gagal memproses laporan live oripa", error);
    await interaction.editReply("❌ Gagal mengirim laporan live ke channel. Hubungi admin.");
  }
}
