import "dotenv/config";
import { ActionRowBuilder, Client, GatewayIntentBits, StringSelectMenuBuilder, TextChannel } from "discord.js";
import { env } from "../src/config/env.js";
import { orderEmbed } from "../src/schedulers/pick-triage.js";
import { buildTriageSelect } from "../src/handlers/pickTriage.js";
import { buildItemPhotos } from "../src/services/itemPhotos.js";

/**
 * Kirim 2 pesan triase PALSU ke channel, memakai embed & dropdown yang sama
 * persis dengan poller — buat melihat format per-order tanpa menunggu barang
 * sungguhan lewat 24 jam.
 *
 * Order id-nya sengaja #999xxx supaya jelas mock dan tidak bentrok dengan order
 * asli di store.
 *
 * Jalankan: node --import tsx scripts/send-mock-pick-triage.ts
 */

const MOCKS = [
  {
    orderId: "999101",
    itemIds: ["461835", "461836", "461840", "461841", "461842"],
    itemNames: [
      'Qinche / Sylus "Night Of Secrecy" Nightly Rendezvous Series Mini Card Set - Love and Deepspace (11,5x6,8cm)',
      'Qinche / Sylus "Night Of Secrecy" Nightly Rendezvous Series Four Panel Mini Album - Love and Deepspace (18x23cm)',
      'Qinche / Sylus "Approaching Dusk" Series Laser Ticket - Love and Deepspace (21x8cm)',
      'Qinche / Sylus "Approaching Dusk" Series Art Print - Love and Deepspace (36,5x24,5cm)',
      'Qinche / Sylus "Approaching Dusk" Series Acrylic Stand - Love and Deepspace (15cm)'
    ],
    // Gambar asli dari master (kyoucdn.id), sejajar dgn itemIds — poller juga
    // mengambilnya dari sana, jadi kolase mock = kolase sungguhan.
    imageUrls: [
      "https://kyoucdn.id/thumbnail/items/483754-kiana-kaslana-herrscher-of-finality-sitting-plush-honkai-impact-3rd-17cm.jpg",
      "https://kyoucdn.id/thumbnail/items/490491-ulpianus-staring-into-the-abyss-character-acrylic-keychain-arknights-95cm.jpg",
      "https://kyoucdn.id/thumbnail/items/547814-qiyu-rafayel-love-and-deepspace-x-wanda-film-collaboration-can-badge-85cm.jpg",
      "https://kyoucdn.id/thumbnail/items/547815-qinche-sylus-love-and-deepspace-x-wanda-film-collaboration-can-badge-85cm.jpg",
      "https://kyoucdn.id/thumbnail/items/481251-qinche-sylus-night-of-secrecy-nightly-rendezvous-series-mini-card-set-love-and-deepspace-115x68cm.jpg"
    ],
    hours: 26,
    user: "Jessica Yuki (MOCK)",
    shipping: "JNE REG",
    isEarly: false,
    eta: ""
  },
  {
    // Ditagih early: ambang 4 hari, embed ungu, dan SENGAJA tanpa mention.
    orderId: "999102",
    itemIds: ["534775", "534776"],
    itemNames: [
      "Tokai Teio Chain Collection (4cm) - Uma Musume Pretty Derby",
      "Nendoroid Racing Miku - 2026 Ver. Hatsune Miku GT Project"
    ],
    imageUrls: [
      "https://kyoucdn.id/thumbnail/items/99323-tokai-teio-chain-collection-4cm-uma-musume-pretty-derby.jpg",
      "https://kyoucdn.id/thumbnail/items/chokodesu-figure-tokai-teio-uma-musume-pretty-derby-10cm-e9396770f45189ef2ffb97f08069a379bf3e162f0cc7a1305ae7fab9cdd4d8c5.jpg"
    ],
    hours: 100,
    user: "Hazel Hazza Niskala (MOCK)",
    shipping: "JNE YES",
    isEarly: true,
    eta: "August-September 2026"
  }
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async (ready) => {
  try {
    const channel = await ready.channels.fetch(env.PICK_TRIAGE_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error("channel bukan text channel");

    for (const mock of MOCKS) {
      // Mention persis seperti poller: semua pesan triase, early maupun bukan.
      const mention = env.PICK_TRIAGE_MENTION_USER_ID
        ? `<@${env.PICK_TRIAGE_MENTION_USER_ID}>`
        : undefined;

      // Foto barang (satu barang satu foto) — sama seperti poller.
      const photos = await buildItemPhotos(mock.imageUrls);

      const message = await (channel as TextChannel).send({
        ...(mention ? { content: mention } : {}),
        embeds: [orderEmbed(mock, photos[0]?.name)],
        ...(photos.length ? { files: photos.map((p) => p.attachment) } : {}),
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            buildTriageSelect({ ...mock, channelId: channel.id, messageId: "" })
          )
        ],
        allowedMentions: { users: mention ? [env.PICK_TRIAGE_MENTION_USER_ID] : [] }
      });
      console.log(
        `terkirim: #${mock.orderId} (${mock.itemNames.length} barang, ${mock.isEarly ? "EARLY" : "biasa"}) ` +
          `→ mention: ${mention ?? "tidak ada"} → ${message.id}`
      );
    }
    console.log("\nCatatan: mock ini TIDAK ditulis ke store — dropdown-nya baru bisa dijawab");
    console.log("setelah bot di server di-redeploy (detailnya dipulihkan dari embed).");
  } catch (err) {
    console.error("Gagal:", err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
