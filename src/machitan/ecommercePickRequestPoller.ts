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
    const table = text(row.source_table ?? row.sourceTable ?? row.table ?? row.row_type ?? row.rowType, "ecommerce_pick_requests");
    return `${table}:id:${String(id).trim()}`;
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
        NULL AS price,
        epr.admin_notes,
        CASE
          WHEN epr.is_physically_picked = 1 THEN 'PHYSICALLY_PICKED'
          ELSE 'REQUESTED'
        END AS status,
        epr.created_at,
        epr.updated_at,
        epr.physical_picked_qty,
        epr.is_physically_picked,
        epr.physically_picked_at,
        epr.physically_picked_by,
        epr.physical_pick_image_path,
        epr.physical_pick_notes,
        picker.name AS picker_name,
        picker.username AS picker_username,
        i.name AS item_name,
        i.character_name,
        img.path AS image_path
      FROM ecommerce_pick_requests epr
      LEFT JOIN users picker ON picker.id = epr.physically_picked_by
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

function proofImageUrl(value: unknown) {
  const raw = text(value, "");
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://kyoucdn.id/${raw.replace(/^\/+/, "")}`;
}

function mentionForChannel(channel: string) {
  const normalized = channel.toLowerCase();
  if (normalized.includes("shopee")) return "<@804685637252939788>";
  if (normalized.includes("tokopedia") || normalized.includes("toped")) return "<@833000054880206888>";
  return "";
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
    .setColor(0x00c853)
    .setTitle(truncate(itemName, 256))
    .addFields(
      { name: "Kode Pesanan", value: truncate(invoiceNumber, 256), inline: true },
      { name: "Picker", value: truncate(picker, 256), inline: true },
      { name: "Qty", value: qty, inline: true },
      { name: "Source", value: source, inline: true }
    )
    .setTimestamp();

  if (stockLogsUrl) {
    embed.setURL(stockLogsUrl);
  }

  const image = proofImageUrl(row.physical_pick_image_path ?? row.physicalPickImagePath);
  if (image) {
    embed.setImage(image);
  }

  if (pickedAt !== "-") {
    embed.setFooter({ text: pickedAt });
  }

  return embed;
}

async function notifyRows(client: Client<true>, rows: EcommercePickRequestRow[]) {
  const channel = await client.channels.fetch(env.MACHITAN_ECOMMERCE_PICK_REQUEST_CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`Cannot send to channel ${env.MACHITAN_ECOMMERCE_PICK_REQUEST_CHANNEL_ID}`);
  }

  for (const row of rows) {
    await channel.send({ content: mentionForChannel(text(row.channel ?? row.sales_channel ?? row.salesChannel ?? row.origin_channel ?? row.originChannel, "")), embeds: [buildEmbed(row)] });
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
