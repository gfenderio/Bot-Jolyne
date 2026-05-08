export const FORBIDDEN_DELIVEREE_CLICK_TEXTS = [
  "Batalkan & Simpan",
  "Konfirmasi",
  "Pesan Pengemudi",
  "Simpan"
] as const;

export function isForbiddenDelivereeClickText(label: string) {
  const normalizedLabel = label.toLowerCase().trim();

  return FORBIDDEN_DELIVEREE_CLICK_TEXTS.some((text) => {
    return normalizedLabel === text.toLowerCase();
  });
}

export function assertSafeDelivereeClickText(label: string) {
  if (isForbiddenDelivereeClickText(label)) {
    throw new Error(`Blocked unsafe Deliveree click: ${label}`);
  }
}

