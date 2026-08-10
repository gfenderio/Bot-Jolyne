import { Client, EmbedBuilder } from "discord.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import { hasProofFor, pruneProofDelivery } from "./proofDelivery.js";

type EcommercePickRequestRow = Record<string, unknown>;

type SeenStore = {
  seenKeys: string[];
  // Sejak kapan poller ini berhak menuduh sebuah pick "tanpa bukti". Ditulis
  // sekali saat pertama jalan dan tidak pernah diubah lagi: pick yang terjadi
  // sebelum buku pengiriman ada memang tidak bisa dinilai, sedangkan pick saat
  // bot mati justru yang paling perlu dinilai — jadi patokannya bukan waktu
  // proses ini menyala.
  watchSince?: number;
};

function text(value: unknown, fallback = "-") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function truncate(value: string, max = 1024) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function numberText(value: unknown, fallback = "-") {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(number) : fallback;
}

function rowKey(row: EcommercePickRequestRow) {
  const id = row.id ?? row.request_id ?? row.ecommerce_pick_request_id ?? row.pick_request_id;
  if (id !== undefined && id !== null && String(id).trim()) {
    const table = text(row.source_table ?? row.sourceTable ?? row.table ?? row.row_type ?? row.rowType, "ecommerce_pick_requests");
    return `${table}:physical-picked:id:${String(id).trim()}`;
  }

  return [
    text(row.invoice_number ?? row.invoiceNumber, ""),
    text(row.item_id ?? row.itemId, ""),
    text(row.source, ""),
    text(row.qty ?? row.quantity, ""),
    text(row.created_at ?? row.createdAt ?? row.requested_at ?? row.requestedAt, "")
  ].join("|");
}

function rowTimestamp(row: EcommercePickRequestRow) {
  const raw = text(row.created_at ?? row.createdAt ?? row.requested_at ?? row.requestedAt ?? row.updated_at ?? row.updatedAt, "");
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : 0;
}

function extractRows(payload: unknown): EcommercePickRequestRow[] {
  if (Array.isArray(payload)) return payload.filter((row): row is EcommercePickRequestRow => Boolean(row && typeof row === "object"));
  if (!payload || typeof payload !== "object") return [];

  const root = payload as Record<string, unknown>;
  const candidates = [root.data, root.rows, root.requests, root.items, root.result];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((row): row is EcommercePickRequestRow => Boolean(row && typeof row === "object"));
    }
  }

  if (root.data && typeof root.data === "object") {
    const nested = root.data as Record<string, unknown>;
    for (const candidate of [nested.data, nested.rows, nested.requests, nested.items]) {
      if (Array.isArray(candidate)) {
        return candidate.filter((row): row is EcommercePickRequestRow => Boolean(row && typeof row === "object"));
      }
    }
  }

  return [];
}

function hasMetabaseConfig() {
  return Boolean(env.METABASE_URL && env.METABASE_EMAIL && env.METABASE_PASSWORD && env.METABASE_DATABASE_ID);
}

function metabaseConfig(): MetabaseConfig {
  if (!env.METABASE_URL || !env.METABASE_EMAIL || !env.METABASE_PASSWORD || !env.METABASE_DATABASE_ID) {
    throw new Error("Metabase env belum lengkap untuk Machitan e-commerce pick request poller.");
  }

  return {
    url: env.METABASE_URL,
    email: env.METABASE_EMAIL,
    password: env.METABASE_PASSWORD,
    databaseId: env.METABASE_DATABASE_ID
  };
}

function datasetToRows(columns: string[], rows: unknown[][]): EcommercePickRequestRow[] {
  return rows.map((row) => {
    const mapped: EcommercePickRequestRow = {};
    columns.forEach((column, index) => {
      mapped[column] = row[index];
    });
    return mapped;
  });
}

async function readSeenStore(path: string): Promise<{ seenKeys: Set<string>; watchSince: number | null }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SeenStore;
    const watchSince = Number(parsed.watchSince);
    return {
      seenKeys: new Set(Array.isArray(parsed.seenKeys) ? parsed.seenKeys.map(String) : []),
      watchSince: Number.isFinite(watchSince) && watchSince > 0 ? watchSince : null
    };
  } catch {
    return { seenKeys: new Set(), watchSince: null };
  }
}

async function writeSeenStore(path: string, seenKeys: Set<string>, watchSince: number) {
  await mkdir(dirname(path), { recursive: true });
  const latest = Array.from(seenKeys).slice(-2000);
  await writeFile(path, JSON.stringify({ seenKeys: latest, watchSince }, null, 2), "utf8");
}

async function fetchEcommercePickRequests() {
  if (!env.MACHITAN_KYOU_API_TOKEN) {
    throw new Error("MACHITAN_KYOU_API_TOKEN belum diisi.");
  }

  const baseUrl = env.MACHITAN_KYOU_API_BASE_URL.replace(/\/$/, "");
  const url = new URL(`${baseUrl}/ecommerce-pick-requests`);
  url.searchParams.set("limit", String(env.MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_LIMIT));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.MACHITAN_KYOU_API_TOKEN}`,
      Accept: "application/json"
    }
  });

  const bodyText = await response.text();
  const payload = bodyText ? JSON.parse(bodyText) as unknown : undefined;

  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload
      ? String((payload as { message?: unknown }).message)
      : bodyText;
    throw new Error(`Kyou API HTTP ${response.status}${message ? `: ${message}` : ""}`);
  }

  return extractRows(payload);
}

async function fetchEcommercePickRequestsFromMetabase() {
  const limit = env.MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_LIMIT;
  const query = `
    SELECT * FROM (
      SELECT
        epr.id,
        'ecommerce_pick_requests' AS source_table,
        epr.invoice_number,
        epr.source,
        CASE
          WHEN epr.admin_notes LIKE 'Tokopedia %' THEN 'Tokopedia'
          WHEN epr.admin_notes LIKE 'Shopee %' THEN 'Shopee'
          ELSE 'E-Commerce'
        END AS channel,
        epr.item_id,
        epr.qty,
        epr.created_at,
        epr.updated_at,
        epr.physical_picked_qty,
        epr.physically_picked_at,
        epr.physically_picked_by,
        picker.name AS picker_name,
        picker.username AS picker_username,
        i.name AS item_name,
        img.path AS image_path
      FROM ecommerce_pick_requests epr
      -- users di kyou.id berkunci user_id; picker.id tidak ada dan bikin seluruh
      -- query ini gagal ("Unknown column 'id'"), jadi jalur Metabase tidak pernah jalan.
      LEFT JOIN users picker ON picker.user_id = epr.physically_picked_by
      LEFT JOIN items i ON i.item_id = epr.item_id
      LEFT JOIN images img ON img.image_id = i.main_img
      WHERE epr.item_id IS NOT NULL
        AND epr.qty > 0
        AND epr.is_physically_picked = 1
      ORDER BY epr.physically_picked_at DESC, epr.id DESC
      LIMIT ${limit}
    ) recent_ecommerce_pick_requests
    ORDER BY id ASC
  `;
  const result = await fetchNativeQueryWithPagination(metabaseConfig(), query, limit);
  return datasetToRows(result.columns, result.rows as unknown[][]);
}

async function fetchEcommercePickRequestRows() {
  if (env.MACHITAN_KYOU_API_TOKEN) {
    try {
      return await fetchEcommercePickRequests();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("HTTP 422") || !hasMetabaseConfig()) {
        throw error;
      }

      console.warn("Kyou API list endpoint butuh invoice_number; fallback ke Metabase outside_orders.");
    }
  }

  return fetchEcommercePickRequestsFromMetabase();
}

function imageUrl(value: unknown) {
  const raw = text(value, "");
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://kyoucdn.id/thumbnail/${raw.replace(/^\/+/, "")}`;
}

function pickedTimestamp(row: EcommercePickRequestRow) {
  const raw = text(row.physically_picked_at ?? row.physicallyPickedAt ?? row.updated_at ?? row.updatedAt, "");
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : 0;
}

function buildEmbed(row: EcommercePickRequestRow) {
  const itemId = text(row.item_id ?? row.itemId);
  const itemName = text(row.item_name ?? row.itemName ?? row.name, "E-Commerce item");
  const invoiceNumber = text(row.invoice_number ?? row.invoiceNumber);
  const source = text(row.source);
  const channel = text(row.channel ?? row.sales_channel ?? row.salesChannel ?? row.origin_channel ?? row.originChannel, "E-Commerce");
  const qty = numberText(row.physical_picked_qty ?? row.physicalPickedQty ?? row.qty ?? row.quantity, "1");
  const picker = text(row.picker_name ?? row.pickerName ?? row.picker_username ?? row.pickerUsername ?? row.physically_picked_by ?? row.physicallyPickedBy, "WH Picker");
  const pickedAt = text(row.physically_picked_at ?? row.physicallyPickedAt ?? row.updated_at ?? row.updatedAt);
  const stockLogsUrl = itemId !== "-" ? `https://old.kyou.id/admin/stock-log/${encodeURIComponent(itemId)}` : undefined;

  const embed = new EmbedBuilder()
    .setColor(0xff6d00)
    .setTitle(truncate(itemName, 256))
    .setDescription("Barang ini tercatat sudah dipick, tapi foto buktinya tidak pernah sampai ke kanal bukti.")
    .addFields(
      { name: "Kode Pesanan", value: truncate(invoiceNumber, 256), inline: true },
      { name: "Toko", value: channel, inline: true },
      { name: "Picker", value: truncate(picker, 256), inline: true },
      { name: "Qty", value: qty, inline: true },
      { name: "Source", value: source, inline: true },
      { name: "Item", value: itemId, inline: true }
    )
    .setTimestamp();

  if (stockLogsUrl) {
    embed.setURL(stockLogsUrl);
  }

  const thumbnail = imageUrl(row.image_path ?? row.imagePath);
  if (thumbnail) {
    embed.setThumbnail(thumbnail);
  }

  if (pickedAt !== "-") {
    embed.setFooter({ text: `Dipick ${pickedAt}` });
  }

  return embed;
}

async function notifyRows(client: Client<true>, rows: EcommercePickRequestRow[]) {
  const channel = await client.channels.fetch(env.MACHITAN_ECOMMERCE_PICK_REQUEST_CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`Cannot send to channel ${env.MACHITAN_ECOMMERCE_PICK_REQUEST_CHANNEL_ID}`);
  }

  // Sengaja tanpa mention: ini kabar buat yang menjaga alurnya, bukan tagihan
  // ke admin toko. Embed per barang, maksimal 10 per pesan.
  for (let index = 0; index < rows.length; index += 10) {
    await channel.send({ embeds: rows.slice(index, index + 10).map(buildEmbed) });
  }
}

export function startMachitanEcommercePickRequestPoller(client: Client<true>) {
  if (!env.MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_ENABLED) {
    return () => undefined;
  }

  if (!env.MACHITAN_KYOU_API_TOKEN && !hasMetabaseConfig()) {
    console.warn("Machitan e-commerce pick request poller aktif, tapi token Kyou/API atau Metabase env belum lengkap. Poller dilewati.");
    return () => undefined;
  }

  let stopped = false;
  let running = false;
  const intervalMs = env.MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_INTERVAL_SECONDS * 1000;
  const graceMs = env.MACHITAN_ECOMMERCE_PICK_REQUEST_GRACE_MINUTES * 60 * 1000;
  let lastPrune = 0;

  const tick = async () => {
    if (stopped || running) return;
    running = true;

    try {
      const store = await readSeenStore(env.MACHITAN_ECOMMERCE_PICK_REQUEST_SEEN_STORE_PATH);
      const seenKeys = store.seenKeys;
      // Pertama kali jalan: pick yang sudah ada dianggap sudah lewat, kecuali
      // sengaja diminta lain lewat NOTIFY_EXISTING.
      const watchSince = store.watchSince
        ?? (env.MACHITAN_ECOMMERCE_PICK_REQUEST_NOTIFY_EXISTING ? 0 : Date.now());

      const rows = (await fetchEcommercePickRequestRows())
        .sort((left, right) => rowTimestamp(left) - rowTimestamp(right));

      const now = Date.now();
      const missingProof: EcommercePickRequestRow[] = [];

      for (const row of rows) {
        const key = rowKey(row);
        if (seenKeys.has(key)) continue;

        const pickedAt = pickedTimestamp(row) || rowTimestamp(row);
        if (!pickedAt) {
          // Tanpa waktu pick, masa tenggangnya tidak bisa dihitung — menuduh
          // "tanpa bukti" di sini cuma tebakan. Dilewati sekali untuk selamanya.
          seenKeys.add(key);
          continue;
        }

        if (pickedAt < watchSince) {
          seenKeys.add(key);
          continue;
        }

        // Masih dalam masa tenggang: PDA boleh terlambat mengirim (kirim ulang
        // otomatis, jaringan gudang lambat). Belum ditandai terlihat supaya
        // dinilai lagi di putaran berikutnya.
        if (now - pickedAt < graceMs) continue;

        const invoiceNumber = text(row.invoice_number ?? row.invoiceNumber, "");
        const itemId = text(row.item_id ?? row.itemId, "");
        if (await hasProofFor(invoiceNumber, itemId)) {
          seenKeys.add(key);
          continue;
        }

        missingProof.push(row);
        seenKeys.add(key);
      }

      if (missingProof.length) {
        await notifyRows(client, missingProof);
      }

      await writeSeenStore(env.MACHITAN_ECOMMERCE_PICK_REQUEST_SEEN_STORE_PATH, seenKeys, watchSince);

      // Buku pengiriman dirapikan sejam sekali saja — tiap putaran cuma kerja sia-sia.
      if (now - lastPrune > 60 * 60 * 1000) {
        lastPrune = now;
        await pruneProofDelivery();
      }
    } catch (error) {
      console.error("Machitan e-commerce pick request poller error:", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  console.log(
    `Pengawas bukti pick e-commerce aktif tiap ${env.MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_INTERVAL_SECONDS} detik ` +
      `(masa tenggang ${env.MACHITAN_ECOMMERCE_PICK_REQUEST_GRACE_MINUTES} menit).`
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
