import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction
} from "discord.js";
import {
  getPosted,
  getResolved,
  isResolved,
  markResolved,
  type PostedItem,
  type TriageChoice
} from "../services/pickTriageStore.js";

// Prefix customId dipakai router di events/interaction-create.ts.
export const TRIAGE_SELECT_PREFIX = "picktriage:sel:"; // + itemId
export const TRIAGE_MODAL_PREFIX = "picktriage:mdl:"; // + itemId + ":" + choice

const EMBED_COLOR_DONE = 0x2f8f5b;

export const CHOICE_META: Record<TriageChoice, { emoji: string; label: string }> = {
  antri: { emoji: "⏳", label: "Masih antri pick" },
  rusak: { emoji: "⚠️", label: "Barang rusak" },
  ketemu: { emoji: "❓", label: "Belum ketemu" }
};

const CHOICE_ORDER: TriageChoice[] = ["antri", "rusak", "ketemu"];

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function choiceLabel(choice: TriageChoice): string {
  const meta = CHOICE_META[choice];
  return `${meta.emoji} ${meta.label}`;
}

/** Dropdown 3 opsi untuk satu barang. */
export function buildTriageSelect(item: PostedItem): StringSelectMenuBuilder {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${TRIAGE_SELECT_PREFIX}${item.itemId}`)
    .setPlaceholder(truncate(`#${item.orderId} · ${item.itemName}`, 100))
    .setMinValues(1)
    .setMaxValues(1);

  for (const choice of CHOICE_ORDER) {
    const meta = CHOICE_META[choice];
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(meta.label)
        .setValue(choice)
        .setEmoji(meta.emoji)
    );
  }
  return menu;
}

function isTriageChoice(value: string): value is TriageChoice {
  return (CHOICE_ORDER as string[]).includes(value);
}

/** User memilih salah satu opsi → tampilkan modal deskripsi. */
export async function handlePickTriageSelect(interaction: StringSelectMenuInteraction) {
  const itemId = interaction.customId.slice(TRIAGE_SELECT_PREFIX.length);
  const choice = interaction.values[0];

  if (!isTriageChoice(choice)) {
    await interaction.reply({ content: "Opsi tidak dikenal.", flags: ["Ephemeral"] });
    return;
  }

  const existing = getResolved(itemId);
  if (existing) {
    await interaction.reply({
      content: `Barang ini sudah dilaporkan oleh **${existing.byTag}** — ${choiceLabel(existing.choice)}.`,
      flags: ["Ephemeral"]
    });
    return;
  }

  const meta = CHOICE_META[choice];
  const modal = new ModalBuilder()
    .setCustomId(`${TRIAGE_MODAL_PREFIX}${itemId}:${choice}`)
    .setTitle(truncate(`${meta.emoji} ${meta.label}`, 45));

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("Deskripsi / keterangan")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000)
    .setPlaceholder("Contoh: sudah dicari di rak Omega, belum ketemu. Kosongkan kalau tidak perlu.");

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput));
  await interaction.showModal(modal);
}

/**
 * Disable dropdown di pesan asal setelah barangnya dijawab. Satu pesan memuat
 * tepat satu barang (satu dropdown), jadi cukup rebuild satu row dari `item` —
 * tidak perlu baca store maupun introspeksi komponen live.
 */
async function disableAnsweredSelect(
  interaction: ModalSubmitInteraction,
  item: PostedItem
): Promise<void> {
  try {
    const channel = await interaction.client.channels.fetch(item.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(item.messageId).catch(() => null);
    if (!message) return;

    const menu = buildTriageSelect(item).setDisabled(true).setPlaceholder("✅ Sudah dilaporkan");
    await message.edit({
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)]
    });
  } catch (err) {
    console.error("[pick-triage] gagal disable dropdown:", err);
  }
}

/**
 * Cadangan kalau store tidak punya metadata barang: baca balik dari embed pesan
 * yang memuat dropdown-nya. Judul embed berformat
 * "... #<orderId> — nyangkut di PICK <n> jam", plus field Barang/Customer/Kurir.
 */
function recoverItemFromMessage(
  interaction: ModalSubmitInteraction,
  itemId: string
): PostedItem | undefined {
  const message = interaction.message;
  const embed = message?.embeds?.[0];
  if (!message || !embed) return undefined;

  const title = embed.title ?? "";
  const orderId = title.match(/#(\S+)/)?.[1] ?? "-";
  const hours = Number(title.match(/(\d+)\s*jam/)?.[1] ?? 0);
  const field = (name: string) =>
    embed.fields?.find((f) => f.name.toLowerCase() === name)?.value?.trim() || "-";

  return {
    itemId,
    orderId,
    itemName: field("barang"),
    user: field("customer"),
    shipping: field("kurir"),
    hours,
    channelId: message.channelId,
    messageId: message.id
  };
}

/** Modal submit → simpan + kirim embed hasil. */
export async function handlePickTriageModal(interaction: ModalSubmitInteraction) {
  // customId = picktriage:mdl:<itemId>:<choice>
  const rest = interaction.customId.slice(TRIAGE_MODAL_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  const itemId = rest.slice(0, sep);
  const choiceRaw = rest.slice(sep + 1);

  if (!isTriageChoice(choiceRaw)) {
    await interaction.reply({ content: "Opsi tidak dikenal.", flags: ["Ephemeral"] });
    return;
  }
  const choice = choiceRaw;

  if (isResolved(itemId)) {
    const prev = getResolved(itemId);
    await interaction.reply({
      content: `Barang ini sudah dilaporkan oleh **${prev?.byTag ?? "?"}**.`,
      flags: ["Ephemeral"]
    });
    return;
  }

  const note = (interaction.fields.getTextInputValue("note") || "").trim() || "-";
  // Store dulu; kalau kosong (proses yang memposting beda dgn yang menangani
  // klik, mis. redeploy di antaranya + data/ ephemeral), pulihkan detail dari
  // embed pesan asalnya supaya embed hasil tidak berisi "-" semua.
  const item = getPosted(itemId) ?? recoverItemFromMessage(interaction, itemId);

  const saved = markResolved(itemId, {
    choice,
    note,
    byId: interaction.user.id,
    byTag: interaction.user.tag,
    at: new Date().toISOString()
  });

  if (!saved) {
    await interaction.reply({
      content: "Barang ini barusan sudah dilaporkan orang lain.",
      flags: ["Ephemeral"]
    });
    return;
  }

  const meta = CHOICE_META[choice];
  const embed = new EmbedBuilder()
    .setTitle(`${meta.emoji} Laporan barang — ${meta.label}`)
    .setColor(EMBED_COLOR_DONE)
    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
    .addFields(
      { name: "Barang", value: item ? truncate(item.itemName, 200) : "-", inline: false },
      { name: "Order", value: item ? `#${item.orderId}` : "-", inline: true },
      { name: "Customer", value: item?.user ?? "-", inline: true },
      { name: "Nyangkut", value: item ? `${item.hours} jam` : "-", inline: true },
      { name: "Kurir", value: item?.shipping ?? "-", inline: true },
      { name: "Status", value: choiceLabel(choice), inline: true },
      { name: "Deskripsi", value: truncate(note, 1000), inline: false }
    )
    .setFooter({ text: `Dilaporkan oleh ${interaction.user.tag}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });

  if (item) {
    await disableAnsweredSelect(interaction, item);
  }
}
