/**
 * Link balik ke halaman order. Dipakai supaya tiap order id yang muncul di
 * Discord bisa langsung diklik ke halaman ordernya, tanpa copy-paste nomor.
 *
 *   https://team.kyou.id/order/362826
 *
 * PINDAH DARI old.kyou.id (9 Sep 2026, permintaan Gilang). Detail order sudah
 * hidup di team.kyou.id dan di situlah orang mengerjakan ordernya sekarang;
 * mengirim mereka ke panel lama berarti satu lompatan tambahan tiap kali.
 * Nomor lama tetap mendarat benar — /orders/<nomor> di team.kyou.id
 * dialihkan ke /order/<nomor>.
 *
 * CUMA halaman order yang pindah. Link CETAK LABEL di bawah tetap ke
 * old.kyou.id, karena yang menerbitkan labelnya memang masih halaman itu.
 */

const ADMIN_ORDER_BASE = "https://team.kyou.id/order";

/**
 * URL halaman order, atau null kalau nilainya bukan satu order id yang wajar
 * (kosong, "-", atau gabungan beberapa id seperti "123, 124"). Null = jangan
 * dijadikan link; Discord menolak embed dengan URL tak valid dan pesannya gagal
 * terkirim seluruhnya.
 */
export function adminOrderUrl(orderId: string | number | null | undefined): string | null {
  const id = String(orderId ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  return `${ADMIN_ORDER_BASE}/${id}`;
}

/**
 * Order id sebagai markdown link (`[#362826](…)`) untuk isi field/description
 * embed. Kalau id-nya tidak bisa dijadikan link, kembalikan teks biasa.
 */
export function orderLink(orderId: string | number | null | undefined, label?: string): string {
  const id = String(orderId ?? "").trim() || "-";
  const text = label ?? `#${id}`;
  const url = adminOrderUrl(id);
  return url ? `[${text}](${url})` : text;
}

/**
 * Link CETAK LABEL untuk satu pack group (gudang) saja.
 *
 *   https://old.kyou.id/admin/orders/print-address?id=396668&packGroupId=2
 *
 * Dibuka = labelnya langsung terbit, berisi HANYA barang gudang itu, dengan
 * berat gudang itu saja. `packGroupId` baru dibaca sejak MR !979 kyou.id
 * (sebelumnya diabaikan, dan labelnya memuat berat SELURUH order — bug 4kg).
 *
 * Membuka link ini juga MENCATAT cetak di admin_logs, sama seperti menekan
 * tombol Print di halaman fulfillment. Jadi jangan disebar ke orang yang cuma
 * mau mengintip.
 */
export function printLabelUrl(orderId: string | number, packGroupId: number): string | null {
  const id = String(orderId ?? "").trim();
  if (!/^\d+$/.test(id) || !Number.isInteger(packGroupId)) return null;
  return `https://old.kyou.id/admin/orders/print-address?id=${id}&packGroupId=${packGroupId}`;
}

/**
 * Tautan cetak yang LEWAT BOT DULU.
 *
 *   https://<bot>/print/396668/2   →  dicatat  →  302 ke printLabelUrl di atas
 *
 * Gunanya cuma satu: bot jadi tahu GUDANG MANA yang dibuka. `admin_logs` tidak
 * menyimpan itu, jadi selama ini ditebak dari lokasi kerja si pencetak — dan
 * tebakan itu meleset tiap kali orang gudang lain yang mengklik. Lihat
 * `splitPrintClickStore.ts` untuk kenapa kliknya tidak diperlakukan sebagai
 * bukti cetak.
 *
 * `base` kosong → balik null, dan pemanggilnya memakai tautan langsung seperti
 * sebelumnya. Jadi fitur ini menyala hanya kalau alamat publiknya memang diisi.
 */
export function printLabelClickUrl(
  orderId: string | number,
  packGroupId: number,
  base: string
): string | null {
  const pangkal = String(base ?? "").trim().replace(/\/+$/, "");
  if (!pangkal) return null;
  const id = String(orderId ?? "").trim();
  if (!/^\d+$/.test(id) || !Number.isInteger(packGroupId)) return null;
  return `${pangkal}/print/${id}/${packGroupId}`;
}
