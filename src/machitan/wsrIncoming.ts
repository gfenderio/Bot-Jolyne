import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";

/**
 * "Barang yang belum benar-benar sampai" per gudang — dipakai layar Price Changes
 * (dulu WSPC) di PDA untuk membuang barang hantu dari daftar.
 *
 * Kenapa ada di sini, bukan di query WSPC-nya sendiri (hanayo): keputusan 27 Jul —
 * hanayo tidak boleh disentuh. Jadi PDA menanyakan daftar ini ke Jolyne, lalu
 * mengurangi sendiri stok yang dipakai untuk memutuskan tampil/tidak.
 *
 * Kenapa tidak PDA saja yang ambil dari endpoint WS Inbox yang sudah ada: endpoint
 * itu dibatasi 500 baris, sementara antrean kedatangan SS 1.036 baris dan LAMBDA
 * 951 (diukur 27 Jul di prod). Terpotong = barang hantu tetap lolos di gudang besar.
 * Metabase tidak kena batas itu.
 *
 * Definisi "belum sampai" DISAMAKAN PERSIS dengan menu WS Inbox di PDA:
 *   stock_logs.ws_inbox_candidate = 1  (kolom generated: type increase + qty > 0 +
 *   belum diopname / masih partial), gudangnya cocok, dan belum ditutup oleh opname
 *   lewat menu Inventory Opname (item_stocks.opnamed_at >= tanggal kedatangan).
 * Jadi begitu gudang mengopname kedatangannya, barangnya muncul sendiri di daftar
 * harga — tidak ada yang hilang diam-diam.
 */

export interface IncomingStock {
  itemId: string;
  qty: number;
}

interface CacheEntry {
  at: number;
  data: IncomingStock[];
}

/**
 * Umur cache. Daftar ini berubah pelan (kedatangan barang, bukan transaksi), dan
 * PDA memanggilnya tiap kali layar dibuka / di-refresh — tanpa cache satu staf
 * yang menekan Refresh berkali-kali menembak Metabase berkali-kali juga.
 */
const CACHE_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** Gudang datang dari PDA; dipakai di query, jadi hanya huruf/angka/strip. */
function isValidSource(source: string): boolean {
  return /^[A-Z0-9_-]{1,50}$/.test(source);
}

function metabaseConfig(): MetabaseConfig | null {
  if (!env.METABASE_URL || !env.METABASE_EMAIL || !env.METABASE_PASSWORD) return null;
  return {
    url: env.METABASE_URL,
    email: env.METABASE_EMAIL,
    password: env.METABASE_PASSWORD,
    databaseId: env.METABASE_DATABASE_ID
  };
}

const incomingQuery = (source: string) => `
  SELECT sl.item_id AS item_id, SUM(sl.quantity) AS qty
  FROM stock_logs sl
  WHERE sl.ws_inbox_candidate = 1
    AND (sl.information->>'$.branch' = '${source}'
      OR sl.information->>'$.source' = '${source}'
      OR sl.information->>'$.to' = '${source}'
      OR sl.information->>'$.destination' = '${source}')
    AND NOT EXISTS (
      SELECT 1 FROM item_stocks s
      WHERE s.item_id = sl.item_id AND s.source = '${source}'
        AND s.opnamed_at IS NOT NULL AND s.opnamed_at >= sl.created_at
    )
  GROUP BY sl.item_id
`;

/**
 * Daftar barang yang stoknya sudah tercatat di gudang ini tapi fisiknya belum
 * diterima. Melempar error kalau Metabase tak bisa dihubungi — pemanggil yang
 * memutuskan apa yang ditampilkan ke staf (PDA memilih tampil apa adanya + tanda
 * "saringan mati", bukan diam-diam menyembunyikan).
 */
export async function fetchIncomingStock(rawSource: string): Promise<IncomingStock[]> {
  const source = rawSource.trim().toUpperCase();
  if (!isValidSource(source)) throw new Error("Nama gudang tidak valid.");

  const cached = cache.get(source);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

  const config = metabaseConfig();
  if (!config) throw new Error("Metabase belum dikonfigurasi di bot.");

  const { columns, rows } = await fetchNativeQueryWithPagination(config, incomingQuery(source));
  const itemIdx = columns.indexOf("item_id");
  const qtyIdx = columns.indexOf("qty");

  const data: IncomingStock[] = rows
    .map((row) => ({
      itemId: String(row[itemIdx] ?? ""),
      qty: Number(row[qtyIdx] ?? 0)
    }))
    .filter((row) => row.itemId !== "" && row.qty > 0);

  cache.set(source, { at: Date.now(), data });
  return data;
}
