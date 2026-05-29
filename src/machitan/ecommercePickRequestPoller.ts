import { Client, EmbedBuilder } from "discord.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";

type EcommercePickRequestRow = Record<string, unknown>;

type SeenStore = {
  seenKeys: string[];
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

function rupiah(value: unknown) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return new Intl.NumberFormat("id-ID", {
    currency: "IDR",
    maximumFractionDigits: 0,
    style: "currency"
  }).format(number);
}

function rowKey(row: EcommercePickRequestRow) {
  const id = row.id ?? row.request_id ?? row.ecommerce_pick_request_id ?? row.pick_request_id;
  if (id !== undefined && id !== null && String(id).trim()) {
    return `id:${String(id).trim()}`;
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

async function readSeenStore(path: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SeenStore;
    return new Set(Array.isArray(parsed.seenKeys) ? parsed.seenKeys.map(String) : []);
  } catch {
    return new Set();
  }
}

async function writeSeenStore(path: string, seenKeys: Set<string>) {
  await mkdir(dirname(path), { recursive: true });
  const latest = Array.from(seenKeys).slice(-2000);
  await writeFile(path, JSON.stringify({ seenKeys: latest }, null, 2), "utf8");
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
        oo.id,
        oo.name AS invoice_number,
        oo.source,
        oo.channel,
        oo.item_id,
        oo.qty,
        oo.price,
        oo.admin_notes,
        oo.status,
        oo.created_at,
        oo.updated_at,
        i.name AS item_name,
        i.character_name,
        img.path AS image_path
      FROM outside_orders oo
      LEFT JOIN items i ON i.item_id = oo.item_id
      LEFT JOIN images img ON img.image_id = i.main_img
      WHERE oo.item_id IS NOT NULL
        AND oo.qty > 0
        AND oo.channel IN ('Tokopedia', 'TOPED', 'Shopee', 'SHOPEE')
      ORDER BY oo.id DESC
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

function buildEmbed(row: EcommercePickRequestRow) {
  const itemId = text(row.item_id ?? row.itemId);
  const itemName = text(row.item_name ?? row.itemName ?? row.name, "E-Commerce item");
  const characterName = text(row.character_name ?? row.characterName, "");
  const invoiceNumber = text(row.invoice_number ?? row.invoiceNumber);
  const source = text(row.source);
  const qty = numberText(row.qty ?? row.quantity, "1");
  const channel = text(row.channel ?? row.sales_channel ?? row.salesChannel ?? row.origin_channel ?? row.originChannel, "E-Commerce");
  const notes = text(row.admin_notes ?? row.adminNotes ?? row.notes);
  const requestedBy = text(row.requested_by ?? row.requestedBy ?? row.created_by ?? row.createdBy ?? row.admin_name ?? row.adminName, "Kyou Extension");
  const price = rupiah(row.price ?? row.sale_price ?? row.salePrice);
  const createdAt = text(row.created_at ?? row.createdAt ?? row.requested_at ?? row.requestedAt);
  const stockLogsUrl = itemId !== "-" ? `https://old.kyou.id/admin/stock-log/${encodeURIComponent(itemId)}` : undefined;

  const embed = new EmbedBuilder()
    .setColor(0x00a3ff)
    .setTitle("🛒 New E-Commerce Pick Request")
    .setDescription(truncate(characterName ? `${itemName}\n${characterName}` : itemName, 256))
    .addFields(
      { name: "Channel", value: channel, inline: true },
      { name: "Invoice/Buyer", value: truncate(invoiceNumber, 256), inline: true },
      { name: "Source", value: source, inline: true },
      { name: "Item ID", value: itemId, inline: true },
      { name: "Qty", value: qty, inline: true },
      { name: "Harga", value: price, inline: true },
      { name: "Requested By", value: truncate(requestedBy, 256), inline: true },
      { name: "Created At", value: truncate(createdAt, 256), inline: true },
      { name: "Notes", value: truncate(notes), inline: false }
    )
    .setTimestamp();

  const thumbnailUrl = imageUrl(row.image_path ?? row.imagePath ?? row.thumbnail_link ?? row.thumbnailLink ?? row.image_link ?? row.imageLink);
  if (thumbnailUrl) {
    embed.setThumbnail(thumbnailUrl);
  }

  if (stockLogsUrl) {
    embed.addFields({ name: "Links", value: `[Stock Logs](${stockLogsUrl})`, inline: false });
  }

  return embed;
}

async function notifyRows(client: Client<true>, rows: EcommercePickRequestRow[]) {
  const channel = await client.channels.fetch(env.MACHITAN_ECOMMERCE_PICK_REQUEST_CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`Cannot send to channel ${env.MACHITAN_ECOMMERCE_PICK_REQUEST_CHANNEL_ID}`);
  }

  for (const row of rows) {
    await channel.send({ embeds: [buildEmbed(row)] });
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
  let firstRun = true;
  const intervalMs = env.MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_INTERVAL_SECONDS * 1000;

  const tick = async () => {
    if (stopped || running) return;
    running = true;

    try {
      const seenKeys = await readSeenStore(env.MACHITAN_ECOMMERCE_PICK_REQUEST_SEEN_STORE_PATH);
      const rows = (await fetchEcommercePickRequestRows())
        .sort((left, right) => rowTimestamp(left) - rowTimestamp(right));
      const newRows = rows.filter((row) => !seenKeys.has(rowKey(row)));

      for (const row of rows) {
        seenKeys.add(rowKey(row));
      }

      if (newRows.length && (!firstRun || env.MACHITAN_ECOMMERCE_PICK_REQUEST_NOTIFY_EXISTING)) {
        await notifyRows(client, newRows);
      }

      await writeSeenStore(env.MACHITAN_ECOMMERCE_PICK_REQUEST_SEEN_STORE_PATH, seenKeys);
      firstRun = false;
    } catch (error) {
      console.error("Machitan e-commerce pick request poller error:", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  console.log(`Machitan e-commerce pick request poller aktif setiap ${env.MACHITAN_ECOMMERCE_PICK_REQUEST_POLL_INTERVAL_SECONDS} detik.`);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
