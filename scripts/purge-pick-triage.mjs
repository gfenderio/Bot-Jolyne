import "dotenv/config";
import fs from "fs";
import path from "path";
import { Client, GatewayIntentBits } from "discord.js";

/**
 * Bersihkan channel triase PICK: hapus SEMUA pesan bot di channel, lalu reset
 * store `data/pick-triage.json`.
 *
 * Dipakai saat format pesan berubah (mis. per-barang → per-order) dan sisa
 * pesan format lama bikin channel campur aduk.
 *
 * Jalankan: node scripts/purge-pick-triage.mjs [--yes]
 * Tanpa --yes: cuma menghitung (dry run), tidak menghapus apa pun.
 *
 * Catatan: store di server (Coolify) tidak dipasangi volume, jadi file di sana
 * ikut kosong sendiri begitu redeploy. Yang direset di sini file lokal.
 */

const CHANNEL_ID = process.env.PICK_TRIAGE_CHANNEL_ID || "1524977369641652227";
const STORE_PATH = process.env.PICK_TRIAGE_STORE_PATH || "data/pick-triage.json";
const APPLY = process.argv.includes("--yes");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async (ready) => {
  try {
    const channel = await ready.channels.fetch(CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error(`channel ${CHANNEL_ID} bukan text channel`);
    console.log(`Channel: #${channel.name} (${CHANNEL_ID})`);

    // Kumpulkan semua pesan milik bot ini, halaman per halaman (100/permintaan).
    const mine = [];
    let before;
    let scanned = 0;
    for (;;) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      scanned += batch.size;
      for (const msg of batch.values()) {
        if (msg.author.id === ready.user.id) mine.push(msg);
      }
      before = batch.last().id;
    }
    console.log(`Discan ${scanned} pesan; ${mine.length} di antaranya milik bot.`);

    if (!APPLY) {
      console.log("DRY RUN — tidak ada yang dihapus. Jalankan ulang dengan --yes untuk benar-benar menghapus.");
      return;
    }

    // Sengaja TIDAK pakai bulkDelete: itu butuh izin Manage Messages, dan bot
    // tidak punya izin itu di channel ini (ditolak 403). Menghapus pesan SENDIRI
    // satu per satu tidak butuh izin apa pun — cuma lebih lambat (rate limit).
    let deleted = 0;
    let failed = 0;
    for (const msg of mine) {
      try {
        await msg.delete();
        deleted += 1;
        if (deleted % 20 === 0) console.log(`terhapus ${deleted}/${mine.length}...`);
      } catch (err) {
        failed += 1;
        console.warn(`gagal hapus ${msg.id}: ${err.message}`);
      }
    }
    console.log(`Terhapus: ${deleted} pesan bot${failed ? `, gagal: ${failed}` : ""}.`);

    const abs = path.resolve(STORE_PATH);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify({ posted: {}, resolved: {} }, null, 2), "utf-8");
    console.log(`Store direset: ${abs}`);
  } catch (err) {
    console.error("Gagal:", err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
