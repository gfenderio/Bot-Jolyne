import { env } from "../config/env.js";

/**
 * Bot-Jolyne's reads from hanayo_prod, through kakera's /v1/jolyne/* endpoints
 * (pkg/jolyneread). Replaces Metabase, which stopped accepting the bot's login
 * on 21 Sep 2026. One endpoint per need — the bot holds no raw SQL access.
 * WSR shipments are not read here at all: kakera pushes them whole.
 */

export function hasKakeraReadConfig(): boolean {
  return Boolean(env.KAKERA_API_URL && env.JOLYNE_READ_KEY);
}

async function kakera<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!hasKakeraReadConfig()) {
    throw new Error("JOLYNE_READ_KEY belum diisi — bot tidak bisa membaca database.");
  }
  const url = `${env.KAKERA_API_URL!.replace(/\/+$/, "")}/v1/jolyne${path}`;
  const response = await fetch(url, {
    ...init,
    headers: { "x-jolyne-key": env.JOLYNE_READ_KEY!, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`kakera /v1/jolyne${path.split("?")[0]} menjawab ${response.status}: ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

export type BirthdayPerson = { username: string; name: string; birthdate: string };

export async function fetchBirthdays(): Promise<BirthdayPerson[]> {
  return (await kakera<{ people: BirthdayPerson[] }>("/birthdays")).people;
}

export type StalePickRow = {
  itemId: string;
  orderId: string;
  itemName: string;
  imagePath: string;
  hoursStuck: number;
  userName: string;
  shippingType: string;
  isEarly: boolean;
  eta: string;
  isPartner: boolean;
};

export async function fetchStalePicks(minHours: number, maxHours: number, earlyMinHours: number): Promise<StalePickRow[]> {
  const q = new URLSearchParams({
    min_hours: String(minHours),
    max_hours: String(maxHours),
    early_min_hours: String(earlyMinHours)
  });
  return (await kakera<{ items: StalePickRow[] }>(`/stale-picks?${q}`)).items;
}

export type OrderState = { orderId: string; status: string; packStatus: number; hasUnpicked: boolean };

export async function fetchOrderProgress(orderIds: string[]): Promise<OrderState[]> {
  if (orderIds.length === 0) return [];
  return (await kakera<{ orders: OrderState[] }>(`/order-progress?ids=${encodeURIComponent(orderIds.join(","))}`)).orders;
}

/** Newest print record, "YYYY-MM-DD HH:MM:SS" in WIB as stored; "" when none. */
export async function fetchSplitWatermark(): Promise<string> {
  return (await kakera<{ latest: string }>("/split-print/watermark")).latest;
}

export type SplitClick = { orderId: string; packGroupId: number; from: string; to: string };

export type SplitRowRaw = {
  orderId: string;
  packGroupId: number;
  city: string;
  warehouses: string;
  pcs: number;
  grams: number;
  items: string[];
  customer: string;
  courier: string;
  printedAt: string;
};

export async function fetchSplits(since: string, until: string, clicks: SplitClick[]): Promise<SplitRowRaw[]> {
  const body = JSON.stringify({ since, until, clicks });
  return (await kakera<{ rows: SplitRowRaw[] }>("/split-print/splits", { method: "POST", body })).rows;
}

export type WsrShipmentPayload = {
  shipment: {
    id: number;
    unit: string;
    direction: string;
    status: string;
    totalItems: number;
    totalQty: number;
    createdBy: string;
    executedBy: string;
    executedAt: string;
    createdAt: string;
  };
  items: Array<{
    batchId: number;
    itemId: string;
    name: string;
    barcode: string;
    source: string;
    destination: string;
    qty: number;
    rack: string;
    status: string;
    error: string;
  }>;
  counts: { moved: number; notMoved: number };
};

/** For the manual resend script only; normal posts arrive as kakera pushes. */
export async function fetchWsrShipment(batchId: number): Promise<WsrShipmentPayload> {
  return kakera<WsrShipmentPayload>(`/wsr/${batchId}`);
}
