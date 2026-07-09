import { env } from "../config/env.js";

export type OrderNotes = {
  adminNotes: string | null;
  userNotes: string | null;
};

export type OrderNotesLookup = {
  // false = API tidak bisa dipakai (token kosong, jaringan mati, order tidak ada
  // di tabel orders). Pemanggil harus balik pakai nilai kiriman PDA.
  authoritative: boolean;
  byOrderId: Map<string, OrderNotes>;
};

type OrderNotesRow = {
  order_id: number | string;
  admin_notes: string | null;
  user_notes: string | null;
};

type OrderNotesResponse = {
  success?: boolean;
  data?: { orders?: OrderNotesRow[] };
};

const EMPTY: OrderNotesLookup = { authoritative: false, byOrderId: new Map() };
const REQUEST_TIMEOUT_MS = 5000;
const MAX_ORDER_IDS = 50;

/**
 * Catatan pembeli & admin diambil langsung dari kyou.id saat proof mau diposting,
 * bukan dari salinan yang dititipkan PDA. PDA memotret catatan saat order di-scan,
 * jadi catatan yang admin tulis setelah itu tidak pernah ikut. Order e-commerce
 * (nomor invoice marketplace) tidak ada di tabel orders — lookup akan kosong dan
 * pemanggil balik ke nilai kiriman PDA.
 */
export async function fetchOrderNotes(orderIds: string[]): Promise<OrderNotesLookup> {
  const numericIds = [...new Set(orderIds.filter((id) => /^\d+$/.test(id)))].slice(0, MAX_ORDER_IDS);
  if (numericIds.length === 0 || !env.MACHITAN_KYOU_API_TOKEN) return EMPTY;

  try {
    const url = `${env.MACHITAN_KYOU_API_BASE_URL}/admin/pda/orders/notes?order_ids=${numericIds.join(",")}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.MACHITAN_KYOU_API_TOKEN}`, "X-App-Name": "machitan" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = (await res.json()) as OrderNotesResponse;
    const rows = json?.success && Array.isArray(json?.data?.orders) ? json.data.orders : [];
    if (rows.length === 0) return EMPTY;

    const byOrderId = new Map<string, OrderNotes>();
    for (const row of rows) {
      byOrderId.set(String(row.order_id), {
        adminNotes: row.admin_notes ? String(row.admin_notes) : null,
        userNotes: row.user_notes ? String(row.user_notes) : null
      });
    }
    return { authoritative: true, byOrderId };
  } catch (err) {
    console.error("Gagal ambil catatan order dari kyou.id, pakai catatan kiriman PDA:", err);
    return EMPTY;
  }
}

/**
 * Gabung catatan beberapa order jadi satu teks. Order tunggal tampil apa adanya;
 * multi-order diberi prefix "Order #X:" supaya packer tahu catatan milik siapa.
 */
export function joinOrderNotes(
  orderIds: string[],
  pick: (notes: OrderNotes) => string | null,
  lookup: OrderNotesLookup
): string | null {
  const multiOrder = orderIds.length > 1;
  const lines = orderIds
    .map((orderId) => {
      const note = pick(lookup.byOrderId.get(orderId) ?? { adminNotes: null, userNotes: null });
      if (!note || !note.trim()) return null;
      return multiOrder ? `Order #${orderId}: ${note.trim()}` : note.trim();
    })
    .filter((line): line is string => !!line);

  return lines.length ? lines.join("\n") : null;
}
