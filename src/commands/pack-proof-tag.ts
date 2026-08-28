import { SlashCommandBuilder, ChannelType, type TextChannel } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import {
  inferEcommerceChannel,
  looksLikeEcommerceOrderId,
  mentionForEcommerce,
} from "../machitan/pickProofIntake.js";

/**
 * Menandai ULANG kartu Pack Proof yang terlanjur terkirim tanpa menyebut
 * petugas e-commerce.
 *
 * Kiriman ulang dari PDA mengirim kartu tanpa rincian item, jadi bot tidak
 * punya bahan untuk mengenali order marketplace dan kartunya lolos tanpa
 * menandai siapa pun. Sisi PDA dan penandaannya sudah diperbaiki, tapi kartu
 * yang SUDAH terkirim tetap diam — dan justru itu yang perlu dilihat orang.
 *
 * Yang dikirim BUKAN kartu baru: kartunya dibalas, jadi tetap satu kartu untuk
 * satu paket dan riwayat channel tidak jadi kembar.
 */
const PACK_PROOF_CHANNEL_ID = "1209860901914677368";
const DEFAULT_SCAN = 50;

/** Order ID di embed bisa berupa tautan markdown: [347419](https://...). */
function orderIdFromField(value: string): string {
  const link = value.match(/^\[([^\]]+)\]/);
  return (link ? link[1] : value).trim().replace(/^#/, "");
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("pack-proof-tag")
    .setDescription("Tandai ulang kartu Pack Proof e-commerce yang belum menyebut petugasnya.")
    .addIntegerOption((o) =>
      o.setName("jumlah")
        .setDescription(`Berapa kartu terakhir yang disisir (bawaan ${DEFAULT_SCAN}, maksimal 200).`)
        .setMinValue(1)
        .setMaxValue(200))
    .addBooleanOption((o) =>
      o.setName("cek_saja")
        .setDescription("Cuma laporkan temuannya, tanpa mengirim apa pun.")),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const limit = interaction.options.getInteger("jumlah") ?? DEFAULT_SCAN;
    const dryRun = interaction.options.getBoolean("cek_saja") ?? false;

    const channel = await interaction.client.channels.fetch(PACK_PROOF_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply(`Channel pack proof (${PACK_PROOF_CHANNEL_ID}) tidak terbaca.`);
      return;
    }

    const messages = await (channel as TextChannel).messages.fetch({ limit });

    // Kartu yang sudah pernah dibalas — entah oleh perintah ini sebelumnya atau
    // oleh orang — tidak ditandai lagi. Menandai dua kali bukan cuma berisik:
    // ia membuat orang mengira ada paket kedua.
    const sudahDibalas = new Set(
      messages
        .filter((m) => Boolean(m.reference?.messageId) && m.content.includes("<@"))
        .map((m) => m.reference!.messageId as string),
    );

    const ditandai: string[] = [];
    const dilewati: string[] = [];

    // Dari yang paling lama, supaya urutan balasannya mengikuti urutan kartunya.
    for (const msg of [...messages.values()].reverse()) {
      const embed = msg.embeds[0];
      if (!embed?.title?.startsWith("Pack Proof")) continue;
      if (msg.content.includes("<@")) continue;
      if (sudahDibalas.has(msg.id)) continue;

      const field = embed.fields.find((f) => f.name === "Order ID");
      if (!field) continue;

      const orderId = orderIdFromField(field.value);
      if (!looksLikeEcommerceOrderId(orderId)) continue;

      const mention = mentionForEcommerce(inferEcommerceChannel(orderId, null));
      if (!mention) {
        dilewati.push(orderId);
        continue;
      }

      if (!dryRun) {
        await msg.reply({
          content: `${mention} Pack Proof order **#${orderId}** sudah masuk — kartunya terkirim tanpa tag.`,
          allowedMentions: { users: [mention.replace(/\D/g, "")] },
        });
      }
      ditandai.push(orderId);
    }

    const judul = dryRun ? "Cek saja — tidak ada yang dikirim" : "Selesai";
    const baris = [
      `**${judul}.** ${limit} kartu terakhir disisir.`,
      ditandai.length
        ? `Ditandai (${ditandai.length}): ${ditandai.join(", ")}`
        : "Tidak ada kartu e-commerce yang tertinggal tanpa tag.",
    ];
    if (dilewati.length) {
      baris.push(`Dilewati karena marketplace-nya tidak jelas (${dilewati.length}): ${dilewati.join(", ")}`);
    }

    await interaction.editReply(baris.join("\n").slice(0, 1900));
  },
};
