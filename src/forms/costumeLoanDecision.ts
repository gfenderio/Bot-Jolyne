import fs from "node:fs";
import path from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";

/**
 * Keputusan atas pengajuan pinjam costume: disetujui / tidak, siapa yang
 * memutuskan, dan alasannya kalau ditolak.
 *
 * Jejaknya sengaja ditulis ke embed pengajuannya sendiri, bukan sebagai balasan
 * terpisah. Balasan gampang tenggelam oleh pengajuan berikutnya, sedangkan yang
 * dicari orang nanti adalah "pengajuan ini akhirnya boleh atau tidak" — jadi
 * jawabannya harus menempel pada pengajuannya. Salinan datanya tetap disimpan
 * di data/ supaya masih ada kalau pesannya dihapus.
 */

export const COSTUME_APPROVE_PREFIX = "costume_approve";
export const COSTUME_REJECT_PREFIX = "costume_reject";
export const COSTUME_REJECT_MODAL_PREFIX = "costume_reject_modal";

const DECISION_FIELD = "Keputusan";
const REASON_FIELD = "Alasan ditolak";
const STORE_PATH = "data/costume-loan-decisions.json";
const MAX_REMEMBERED = 1000;
const COLOR_APPROVED = 0x2f8f5b;
const COLOR_REJECTED = 0xd9534f;

type DecisionRecord = {
  responseId: string;
  disetujui: boolean;
  olehId: string;
  olehNama: string;
  alasan: string | null;
  waktu: string;
  messageId: string;
};

export function decisionButtons(responseId: string | null) {
  const suffix = responseId ? `:${responseId}` : "";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COSTUME_APPROVE_PREFIX}${suffix}`)
      .setLabel("Setujui")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${COSTUME_REJECT_PREFIX}${suffix}`)
      .setLabel("Tidak Disetujui")
      .setStyle(ButtonStyle.Danger)
  );
}

function responseIdFrom(customId: string): string | null {
  const index = customId.indexOf(":");
  return index === -1 ? null : customId.slice(index + 1) || null;
}

function catatKeputusan(record: DecisionRecord) {
  let semua: DecisionRecord[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    if (Array.isArray(parsed)) semua = parsed as DecisionRecord[];
  } catch {
    semua = [];
  }
  semua.push(record);
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(semua.slice(-MAX_REMEMBERED), null, 2), "utf-8");
}

/** Jam WIB, ditulis apa adanya supaya tidak perlu dihitung ulang saat dibaca. */
function waktuJakarta(): string {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}

export function buildDecidedEmbed(
  asli: EmbedBuilder,
  opsi: { disetujui: boolean; olehId: string; alasan: string | null }
): EmbedBuilder {
  const embed = EmbedBuilder.from(asli.data);
  embed.setColor(opsi.disetujui ? COLOR_APPROVED : COLOR_REJECTED);
  embed.addFields({
    name: DECISION_FIELD,
    value: opsi.disetujui
      ? `✅ Disetujui oleh <@${opsi.olehId}> · ${waktuJakarta()} WIB`
      : `❌ Tidak disetujui oleh <@${opsi.olehId}> · ${waktuJakarta()} WIB`
  });

  if (!opsi.disetujui) {
    embed.addFields({ name: REASON_FIELD, value: (opsi.alasan || "—").slice(0, 1000) });
  }

  return embed;
}

/** Sudah pernah diputuskan? Dicek dari embed-nya sendiri, bukan dari berkas. */
function sudahDiputuskan(fields: { name: string }[] | undefined): boolean {
  return (fields ?? []).some((f) => f.name === DECISION_FIELD);
}

async function terapkanKeputusan(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  opsi: { disetujui: boolean; alasan: string | null }
): Promise<void> {
  const message = interaction.message;
  const embedLama = message?.embeds?.[0];
  if (!message || !embedLama) {
    await interaction.reply({
      content: "❌ Embed pengajuannya tidak ketemu, keputusan tidak dicatat.",
      ephemeral: true
    });
    return;
  }

  if (sudahDiputuskan(embedLama.fields)) {
    await interaction.reply({
      content: "⚠️ Pengajuan ini sudah diputuskan sebelumnya. Lihat keterangan di embed-nya.",
      ephemeral: true
    });
    return;
  }

  const embedBaru = buildDecidedEmbed(EmbedBuilder.from(embedLama), {
    disetujui: opsi.disetujui,
    olehId: interaction.user.id,
    alasan: opsi.alasan
  });

  const payload = { embeds: [embedBaru], components: [] };
  if (interaction.isButton() || (interaction.isModalSubmit() && interaction.isFromMessage())) {
    await interaction.update(payload);
  } else {
    await message.edit(payload);
    await interaction.reply({ content: "✅ Keputusan dicatat.", ephemeral: true });
  }

  catatKeputusan({
    responseId: responseIdFrom(interaction.customId) ?? message.id,
    disetujui: opsi.disetujui,
    olehId: interaction.user.id,
    olehNama: interaction.user.tag,
    alasan: opsi.alasan,
    waktu: new Date().toISOString(),
    messageId: message.id
  });

  console.log(
    `[costume-loan] ${opsi.disetujui ? "disetujui" : "ditolak"} oleh ${interaction.user.tag} (pesan ${message.id}).`
  );
}

export async function handleCostumeLoanButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId.startsWith(COSTUME_APPROVE_PREFIX)) {
    await terapkanKeputusan(interaction, { disetujui: true, alasan: null });
    return;
  }

  // Penolakan wajib berasalan: tanpa itu, peminjam cuma tahu "tidak boleh"
  // tanpa tahu apa yang harus dibetulkan.
  const modal = new ModalBuilder()
    .setCustomId(`${COSTUME_REJECT_MODAL_PREFIX}:${responseIdFrom(interaction.customId) ?? ""}`)
    .setTitle("Alasan Tidak Disetujui");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("alasan")
        .setLabel("Kenapa tidak disetujui?")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(900)
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

export async function handleCostumeLoanRejectModal(interaction: ModalSubmitInteraction): Promise<void> {
  const alasan = interaction.fields.getTextInputValue("alasan").trim();
  await terapkanKeputusan(interaction, { disetujui: false, alasan: alasan || null });
}
