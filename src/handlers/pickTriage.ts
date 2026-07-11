import {
  ActionRowBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction
} from "discord.js";
import { env } from "../config/env.js";
import { fitImageToLimit, DISCORD_BOT_ATTACHMENT_LIMIT_BYTES } from "../machitan/imageFit.js";
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

const NOTE_FIELD = "note";
const PHOTO_FIELD = "photo";

const EMBED_COLOR_DONE = 0x2f8f5b;

export const CHOICE_META: Record<TriageChoice, { emoji: string; label: string; hint: string }> = {
  antri: { emoji: "⏳", label: "Masih antri pick", hint: "Contoh: antrean panjang, belum sempat diambil." },
  rusak: { emoji: "⚠️", label: "Barang rusak", hint: "Contoh: box penyok, segel sobek." },
  ketemu: { emoji: "❓", label: "Belum ketemu", hint: "Contoh: sudah dicari di rak Omega, tidak ada." }
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

  // Komponen modal gaya baru (Label membungkus input) — inilah yang memungkinkan
  // kolom UPLOAD FILE di dalam modal. Dulu modal cuma bisa teks, makanya fotonya
  // sempat diminta lewat pesan biasa + message collector (butuh intent
  // MessageContent yang privileged). Itu semua sudah dibuang.
  modal.addLabelComponents(
    new LabelBuilder().setLabel("Deskripsi / keterangan").setTextInputComponent(
      new TextInputBuilder()
        .setCustomId(NOTE_FIELD)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000)
        // Placeholder Discord dibatasi 100 karakter — lewat sedikit saja,
        // showModal melempar dan pengklik cuma melihat "This interaction failed".
        .setPlaceholder(truncate(meta.hint, 100))
    )
  );

  if (choice === "rusak" && env.PICK_TRIAGE_PHOTO_ENABLED) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel("Foto barang rusak")
        .setDescription("Opsional — boleh dikosongkan.")
        .setFileUploadComponent(
          new FileUploadBuilder().setCustomId(PHOTO_FIELD).setRequired(false).setMinValues(0).setMaxValues(1)
        )
    );
  }

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

/**
 * Ambil foto "barang rusak" dari kolom upload DI DALAM modal, siap ditempel ke
 * embed hasil.
 *
 * Foto di-UNGGAH ULANG sebagai lampiran embed, bukan disimpan URL-nya: URL CDN
 * Discord bertanda tangan dan kedaluwarsa (~24 jam), jadi embed yang cuma
 * menunjuk URL asli akan kehilangan gambarnya.
 *
 * Return null kalau pelapor tidak melampirkan apa-apa (fotonya opsional) atau
 * kalau fotonya gagal diambil — embed hasil tetap dikirim, cuma tanpa gambar.
 */
async function damagePhotoAttachment(
  interaction: ModalSubmitInteraction
): Promise<AttachmentBuilder | null> {
  if (!env.PICK_TRIAGE_PHOTO_ENABLED) return null;

  // getUploadedFiles() melempar kalau komponennya tidak ada di modal — mis. pesan
  // lama yang modalnya dibangun sebelum kolom foto ada.
  let uploaded;
  try {
    uploaded = interaction.fields.getUploadedFiles(PHOTO_FIELD)?.first();
  } catch {
    return null;
  }

  if (!uploaded) {
    console.log("[pick-triage] barang rusak dilaporkan tanpa foto.");
    return null;
  }

  try {
    const res = await fetch(uploaded.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Foto dari HP gampang lewat 8 MB; kecilkan seperlunya, bukan ditolak.
    const buffer = await fitImageToLimit(
      Buffer.from(await res.arrayBuffer()),
      DISCORD_BOT_ATTACHMENT_LIMIT_BYTES
    );

    const ext = uploaded.name?.split(".").pop() ?? "jpg";
    console.log(`[pick-triage] foto barang rusak diterima (${Math.round(buffer.length / 1024)} KB).`);
    return new AttachmentBuilder(buffer, { name: `rusak-${interaction.id}.${ext}` });
  } catch (err) {
    console.error("[pick-triage] gagal mengambil foto barang rusak:", err);
    return null;
  }
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

  const note = (interaction.fields.getTextInputValue(NOTE_FIELD) || "").trim() || "-";
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

  // Foto (kalau ada) ikut dikirim bareng embed hasil — bukan ditambal belakangan.
  // Mengunduh + mengecilkan foto bisa makan waktu, jadi interaksinya di-defer
  // dulu supaya tidak lewat batas 3 detik Discord.
  const photo = choice === "rusak" ? await withDefer(interaction, () => damagePhotoAttachment(interaction)) : null;
  if (photo) embed.setImage(`attachment://${photo.name}`);

  const payload = { embeds: [embed], ...(photo ? { files: [photo] } : {}) };
  if (interaction.deferred) await interaction.editReply(payload);
  else await interaction.reply(payload);

  if (order) {
    await removeAnsweredMessage(interaction, order);
  }
}

/** Defer dulu (pekerjaannya bisa > 3 detik), baru jalankan. */
async function withDefer<T>(interaction: ModalSubmitInteraction, run: () => Promise<T>): Promise<T> {
  await interaction.deferReply();
  return run();
}
