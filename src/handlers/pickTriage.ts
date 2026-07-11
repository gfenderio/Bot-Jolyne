import {
  ActionRowBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction
} from "discord.js";
import { env } from "../config/env.js";
import { adminOrderUrl, orderLink } from "../services/kyouLinks.js";
import {
  getPosted,
  getResolved,
  isResolved,
  markResolved,
  type PostedOrder,
  type TriageChoice
} from "../services/pickTriageStore.js";

// Prefix customId dipakai router di events/interaction-create.ts.
export const TRIAGE_SELECT_PREFIX = "picktriage:sel:"; // + orderId
export const TRIAGE_MODAL_PREFIX = "picktriage:mdl:"; // + orderId + ":" + choice

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

// Field value Discord dibatasi 1024 karakter; sisakan ruang buat baris "dan N
// lainnya".
const MAX_ITEM_LIST_CHARS = 900;

/**
 * Daftar barang satu order sebagai bullet, tiap baris diawali ITEM ID supaya
 * staf bisa langsung mencocokkan dengan barang di rak/admin:
 *
 *     • `461835` — Nama barang (17cm)
 *
 * Format itu juga yang dibaca balik oleh recoverOrderFromMessage(), jadi kalau
 * diubah, ubah regex di sana.
 *
 * Kalau kepanjangan, daftar dipotong dan sisanya diringkas — order berisi
 * belasan barang bisa melewati limit field Discord (1024) dan membuat
 * pengiriman pesannya gagal total.
 */
export function itemListValue(names: string[], ids: string[] = []): string {
  if (names.length === 0) return "-";

  const lines: string[] = [];
  let chars = 0;
  for (const [i, name] of names.entries()) {
    const id = ids[i];
    const line = id ? `• \`${id}\` — ${truncate(name, 110)}` : `• ${truncate(name, 120)}`;
    if (chars + line.length + 1 > MAX_ITEM_LIST_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }

  const rest = names.length - lines.length;
  if (rest > 0) lines.push(`_…dan ${rest} barang lainnya_`);
  return lines.join("\n");
}

/** Dropdown 3 opsi untuk satu order (berlaku buat semua barangnya). */
export function buildTriageSelect(order: PostedOrder): StringSelectMenuBuilder {
  const count = order.itemNames.length;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${TRIAGE_SELECT_PREFIX}${order.orderId}`)
    .setPlaceholder(truncate(`#${order.orderId} · ${count} barang — pilih status`, 100))
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
  const orderId = interaction.customId.slice(TRIAGE_SELECT_PREFIX.length);
  const choice = interaction.values[0];

  if (!isTriageChoice(choice)) {
    await interaction.reply({ content: "Opsi tidak dikenal.", flags: ["Ephemeral"] });
    return;
  }

  const existing = getResolved(orderId);
  if (existing) {
    await interaction.reply({
      content: `Order ini sudah dilaporkan oleh **${existing.byTag}** — ${choiceLabel(existing.choice)}.`,
      flags: ["Ephemeral"]
    });
    return;
  }

  const meta = CHOICE_META[choice];
  const modal = new ModalBuilder()
    .setCustomId(`${TRIAGE_MODAL_PREFIX}${orderId}:${choice}`)
    .setTitle(truncate(`${meta.emoji} ${meta.label}`, 45));

  const noteInput = new TextInputBuilder()
    .setCustomId("note")
    .setLabel("Deskripsi / keterangan")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000)
    .setPlaceholder("Kalau tiap barang beda kasusnya, sebutkan di sini. Contoh: Laser Ticket belum ketemu, Art Print rusak.");

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput));
  await interaction.showModal(modal);
}

/**
 * Hapus pesan pertanyaan setelah order-nya dijawab — embed hasil sudah memuat
 * semua isinya (order, daftar barang, customer, kurir, lama nyangkut), jadi
 * membiarkan pesan asal cuma bikin channel panjang. Kalau gagal hapus (mis. bot
 * kehilangan izin Manage Messages), jatuh balik ke men-disable dropdown supaya
 * pesannya tidak bisa dijawab dua kali.
 */
async function removeAnsweredMessage(
  interaction: ModalSubmitInteraction,
  order: PostedOrder
): Promise<void> {
  const channel = await interaction.client.channels.fetch(order.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const message = await channel.messages.fetch(order.messageId).catch(() => null);
  if (!message) return;

  try {
    await message.delete();
  } catch (err) {
    console.error("[pick-triage] gagal hapus pesan pertanyaan, disable dropdown saja:", err);
    const menu = buildTriageSelect(order).setDisabled(true).setPlaceholder("✅ Sudah dilaporkan");
    await message
      .edit({ components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] })
      .catch(() => {});
  }
}

/**
 * Cadangan kalau store tidak punya metadata order: baca balik dari embed pesan
 * yang memuat dropdown-nya. Judul embed berformat
 * "🔴 #<orderId> — nyangkut di PICK <n> jam · <k> barang", plus field
 * Barang (daftar bullet) / Customer / Kurir.
 */
function recoverOrderFromMessage(
  interaction: ModalSubmitInteraction,
  orderId: string
): PostedOrder | undefined {
  const message = interaction.message;
  const embed = message?.embeds?.[0];
  if (!message || !embed) return undefined;

  const title = embed.title ?? "";
  const hours = Number(title.match(/(\d+)\s*jam/)?.[1] ?? 0);
  // Nomor order dibaca dari judul, bukan dari customId: pesan versi lama yang
  // masih nangkring di channel ber-customId ITEM id, dan kalau dipakai apa
  // adanya kolom "Order" di embed hasil akan menampilkan item id.
  const titleOrderId = title.match(/#(\S+)/)?.[1];
  const field = (name: string) =>
    embed.fields?.find((f) => f.name.toLowerCase() === name)?.value?.trim() || "-";

  // Baris berformat "• `<itemId>` — <nama>" (lihat itemListValue). Baris ringkas
  // "…dan N barang lainnya" dan bullet tanpa id (format lama) tetap ditoleransi.
  const itemIds: string[] = [];
  const itemNames: string[] = [];
  for (const raw of field("barang").split("\n")) {
    const line = raw.trim();
    if (!line || line === "-" || line.startsWith("_")) continue;

    const withId = line.match(/^•\s*`([^`]+)`\s*—\s*(.+)$/);
    if (withId) {
      itemIds.push(withId[1]);
      itemNames.push(withId[2].trim());
      continue;
    }
    itemNames.push(line.replace(/^•\s*/, ""));
  }

  return {
    orderId: titleOrderId ?? orderId,
    itemIds,
    itemNames,
    user: field("customer"),
    shipping: field("kurir"),
    hours,
    channelId: message.channelId,
    messageId: message.id
  };
}

const PHOTO_MAX_BYTES = 8 * 1024 * 1024; // batas upload Discord tanpa boost

/**
 * Untuk "Barang rusak": minta pelapor mengunggah foto di channel, lalu tempel
 * ke embed hasil. Fotonya OPSIONAL — boleh `skip`, boleh dibiarkan sampai waktu
 * habis; embed hasil tetap ada, cuma tanpa gambar.
 *
 * Modal Discord tidak bisa menerima file, jadi fotonya harus lewat pesan biasa
 * — butuh intent MessageContent (privileged). Kalau intent itu mati, collector
 * tidak akan pernah menerima apa pun; makanya seluruh alur ini dijaga flag
 * PICK_TRIAGE_PHOTO_ENABLED yang juga mengatur intent di index.ts.
 *
 * Prompt-nya PESAN BIASA (bukan ephemeral) yang me-mention pelapor: pesan
 * ephemeral gampang kelewat/ketutup, dan user melaporkan promptnya "tidak ada"
 * padahal fiturnya jalan. Pesan biasa dihapus lagi setelah selesai, jadi channel
 * tetap bersih.
 *
 * Fotonya di-UNGGAH ULANG sebagai lampiran embed, bukan disimpan URL-nya: URL
 * CDN Discord bertanda tangan dan kedaluwarsa (~24 jam), jadi embed yang cuma
 * menunjuk URL asli akan kehilangan gambar. Setelah tertempel, pesan unggahan
 * mentahnya dihapus supaya channel bersih.
 */
async function collectDamagePhoto(
  interaction: ModalSubmitInteraction,
  embed: EmbedBuilder
): Promise<void> {
  if (!env.PICK_TRIAGE_PHOTO_ENABLED) {
    console.warn("[pick-triage] foto dilewati — PICK_TRIAGE_PHOTO_ENABLED=false.");
    return;
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || !("createMessageCollector" in channel)) {
    console.warn("[pick-triage] foto dilewati — channel tidak bisa dipasangi collector.");
    return;
  }

  const seconds = env.PICK_TRIAGE_PHOTO_WAIT_SECONDS;
  const prompt = await channel
    .send({
      content:
        `📷 <@${interaction.user.id}> — upload **foto barang rusak** di channel ini dalam ${seconds} detik.\n` +
        "Fotonya **opsional**: ketik `skip` atau diamkan saja kalau tidak ada."
    })
    .catch((err) => {
      console.error("[pick-triage] gagal kirim ajakan upload foto:", err);
      return null;
    });

  const collector = channel.createMessageCollector({
    filter: (m) =>
      m.author.id === interaction.user.id &&
      (m.attachments.size > 0 || m.content.trim().toLowerCase() === "skip"),
    max: 1,
    time: seconds * 1000
  });
  console.log(`[pick-triage] menunggu foto barang rusak dari ${interaction.user.tag} (${seconds}s).`);

  const dropPrompt = async () => {
    if (prompt) await prompt.delete().catch(() => {});
  };

  collector.on("collect", async (message) => {
    const cleanup = async () => {
      // Menghapus pesan ORANG LAIN butuh izin Manage Messages — bot tidak
      // punya itu di #pending-shipment (dicek 2026-07-11: bulk-delete ditolak
      // 403). Jadi pesan unggahan mentahnya kemungkinan tetap tertinggal;
      // fotonya sudah tersalin ke embed, jadi ini kosmetik saja.
      await message.delete().catch(() => {
        console.warn("[pick-triage] tidak bisa hapus pesan unggahan pelapor (butuh izin Manage Messages).");
      });
      await dropPrompt();
    };

    if (message.attachments.size === 0) {
      console.log("[pick-triage] pelapor memilih skip — embed hasil tanpa foto.");
      await cleanup();
      return;
    }

    const photo = message.attachments.find((a) => a.contentType?.startsWith("image/") ?? false);
    if (!photo) {
      await interaction.followUp({ content: "❌ Itu bukan file gambar. Foto tidak ditempel.", flags: ["Ephemeral"] }).catch(() => {});
      await cleanup();
      return;
    }
    if (photo.size > PHOTO_MAX_BYTES) {
      await interaction.followUp({ content: "❌ Foto terlalu besar (maks 8 MB). Foto tidak ditempel.", flags: ["Ephemeral"] }).catch(() => {});
      await cleanup();
      return;
    }

    try {
      const res = await fetch(photo.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      const name = `rusak-${Date.now()}.${photo.name.split(".").pop() ?? "png"}`;
      const file = new AttachmentBuilder(buffer, { name });
      embed.setImage(`attachment://${name}`);

      await interaction.editReply({ embeds: [embed], files: [file] });
      await cleanup();
      console.log("[pick-triage] foto barang rusak tertempel ke embed hasil.");
    } catch (err) {
      console.error("[pick-triage] gagal menempel foto:", err);
      await interaction.followUp({ content: "❌ Gagal menempel foto. Coba upload ulang di channel ini.", flags: ["Ephemeral"] }).catch(() => {});
    }
  });

  collector.on("end", (collected) => {
    // Waktu habis tanpa foto: buang ajakannya, embed hasil tetap ada (tanpa foto).
    if (collected.size === 0) {
      console.log("[pick-triage] waktu upload foto habis — tidak ada foto.");
      void dropPrompt();
    }
  });
}

/** Modal submit → simpan + kirim embed hasil. */
export async function handlePickTriageModal(interaction: ModalSubmitInteraction) {
  // customId = picktriage:mdl:<orderId>:<choice>
  const rest = interaction.customId.slice(TRIAGE_MODAL_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  const orderId = rest.slice(0, sep);
  const choiceRaw = rest.slice(sep + 1);

  if (!isTriageChoice(choiceRaw)) {
    await interaction.reply({ content: "Opsi tidak dikenal.", flags: ["Ephemeral"] });
    return;
  }
  const choice = choiceRaw;

  if (isResolved(orderId)) {
    const prev = getResolved(orderId);
    await interaction.reply({
      content: `Order ini sudah dilaporkan oleh **${prev?.byTag ?? "?"}**.`,
      flags: ["Ephemeral"]
    });
    return;
  }

  const note = (interaction.fields.getTextInputValue("note") || "").trim() || "-";
  // Store dulu; kalau kosong (proses yang memposting beda dgn yang menangani
  // klik, mis. redeploy di antaranya + data/ ephemeral), pulihkan detail dari
  // embed pesan asalnya supaya embed hasil tidak berisi "-" semua.
  const order = getPosted(orderId) ?? recoverOrderFromMessage(interaction, orderId);

  const saved = markResolved(orderId, {
    choice,
    note,
    byId: interaction.user.id,
    byTag: interaction.user.tag,
    at: new Date().toISOString()
  });

  if (!saved) {
    await interaction.reply({
      content: "Order ini barusan sudah dilaporkan orang lain.",
      flags: ["Ephemeral"]
    });
    return;
  }

  const meta = CHOICE_META[choice];
  const itemCount = order?.itemNames.length ?? 0;
  const orderUrl = adminOrderUrl(order?.orderId ?? orderId);
  const embed = new EmbedBuilder()
    .setTitle(`${meta.emoji} Laporan order — ${meta.label}`)
    .setURL(orderUrl ?? null)
    .setColor(EMBED_COLOR_DONE)
    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
    .addFields(
      {
        name: itemCount > 1 ? `Barang (${itemCount})` : "Barang",
        value: order ? itemListValue(order.itemNames, order.itemIds) : "-",
        inline: false
      },
      { name: "Order", value: orderLink(order?.orderId ?? orderId), inline: true },
      { name: "Customer", value: order?.user ?? "-", inline: true },
      { name: "Nyangkut", value: order ? `${order.hours} jam` : "-", inline: true },
      { name: "Kurir", value: order?.shipping ?? "-", inline: true },
      { name: "Status", value: choiceLabel(choice), inline: true },
      { name: "Deskripsi", value: truncate(note, 1000), inline: false }
    )
    .setFooter({ text: `Dilaporkan oleh ${interaction.user.tag}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });

  // Barang rusak: minta foto, lalu tempel ke embed hasil.
  if (choice === "rusak") {
    void collectDamagePhoto(interaction, embed);
  }

  if (order) {
    await removeAnsweredMessage(interaction, order);
  }
}
