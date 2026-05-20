export const DELIVEREE_WEB_STATUSES = [
  "cancelled",
  "captcha_or_security_challenge",
  "completed",
  "draft_prepared",
  "driver_assigned",
  "going_to_destination",
  "going_to_pickup",
  "arrived_destination",
  "active_booking",
  "waiting_pickup",
  "login_required",
  "no_driver_found",
  "searching_driver",
  "unknown"
] as const;

export type DelivereeWebStatus = (typeof DELIVEREE_WEB_STATUSES)[number];

export type DelivereePageClassification = {
  detectedTexts: string[];
  finalActionVisible: boolean;
  recommendedAction: string;
  status: DelivereeWebStatus;
  summary: string;
};

const finalActionTexts = [
  "batalkan & simpan",
  "konfirmasi",
  "pesan pengemudi",
  "simpan"
];

function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text: string, candidates: string[]) {
  return candidates.some((candidate) => text.includes(candidate));
}

function hasBatalBadge(text: string) {
  return /\bbatal\b/i.test(text) && !text.toLowerCase().includes("batalkan & simpan");
}

export function classifyDelivereePageText(rawText: string): DelivereePageClassification {
  const text = normalizeText(rawText);
  const detectedTexts: string[] = [];
  const finalActionVisible = includesAny(text, finalActionTexts);

  if (includesAny(text, ["captcha", "security check", "verifikasi keamanan"])) {
    detectedTexts.push("captcha/security");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Pause automation dan minta login/review manual.",
      status: "captcha_or_security_challenge",
      summary: "Deliveree menampilkan security challenge."
    };
  }

  if (includesAny(text, ["masuk", "login"]) && includesAny(text, ["password", "email"])) {
    detectedTexts.push("login");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Login manual ke browser session Playwright.",
      status: "login_required",
      summary: "Session Deliveree belum login atau sudah expired."
    };
  }

  if (text.includes("tidak bisa menemukan driver")) {
    detectedTexts.push("tidak bisa menemukan driver");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Review order dan siapkan assisted reorder secara manual/owner-only.",
      status: "no_driver_found",
      summary: "Deliveree tidak bisa menemukan driver untuk order ini."
    };
  }

  if (hasBatalBadge(rawText)) {
    detectedTexts.push("batal");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Cek apakah order perlu replacement/reorder.",
      status: "cancelled",
      summary: "Order Deliveree terlihat berstatus batal."
    };
  }

  if (includesAny(text, ["selesai", "completed"])) {
    detectedTexts.push("selesai");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Close recovery case jika sudah tidak ada follow-up.",
      status: "completed",
      summary: "Order Deliveree terlihat selesai."
    };
  }

  if (includesAny(text, ["di tujuan", "di lokasi akhir pada", "arrived at destination"])) {
    detectedTexts.push("di tujuan");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Pantau sampai order selesai atau ada kendala dokumen/foto.",
      status: "arrived_destination",
      summary: "Driver sudah berada di tujuan."
    };
  }

  if (includesAny(text, ["menuju tujuan", "going to destination"])) {
    detectedTexts.push("menuju tujuan");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Pantau ETA dan keterlambatan jika estimasi berubah terlalu jauh.",
      status: "going_to_destination",
      summary: "Driver sedang menuju tujuan."
    };
  }

  if (includesAny(text, ["menuju penjemputan", "going to pickup"])) {
    detectedTexts.push("menuju penjemputan");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Pantau sampai driver tiba di lokasi penjemputan.",
      status: "going_to_pickup",
      summary: "Driver sedang menuju lokasi penjemputan."
    };
  }

  if (includesAny(text, ["menunggu penjemputan", "waiting pickup", "waiting for pickup"])) {
    detectedTexts.push("menunggu penjemputan");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Pantau waktu tunggu pickup dan follow up jika terlalu lama.",
      status: "waiting_pickup",
      summary: "Driver sudah menunggu di lokasi penjemputan."
    };
  }

  if (includesAny(text, ["memilih", "mencari pengemudi", "tidak ada info pengemudi", "mengonfirmasi"])) {
    detectedTexts.push("memilih/mencari pengemudi");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Pantau sampai driver didapat atau Deliveree gagal menemukan driver.",
      status: "searching_driver",
      summary: "Order masih dalam proses pencarian/konfirmasi driver."
    };
  }

  if (
    includesAny(text, ["driver", "pengemudi"])
    && includesAny(text, ["plat", "kendaraan", "dalam perjalanan", "arrived", "pickup"])
  ) {
    detectedTexts.push("driver/pengemudi");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Pantau progress dan trigger stuck alert jika status tidak berubah.",
      status: "driver_assigned",
      summary: "Driver/pengemudi terlihat sudah tersedia atau sedang berjalan."
    };
  }

  if (includesAny(text, ["1. rute", "2. layanan", "3. rincian", "pesan pengemudi"])) {
    detectedTexts.push("flow pemesanan");
    return {
      detectedTexts,
      finalActionVisible,
      recommendedAction: "Stop before submit. Jangan klik tombol final order.",
      status: "draft_prepared",
      summary: "Halaman berada di flow draft/pemesanan Deliveree."
    };
  }

  return {
    detectedTexts,
    finalActionVisible,
    recommendedAction: "Kirim screenshot untuk review manual sebelum action apa pun.",
    status: "unknown",
    summary: "Sistem belum mengenali state halaman Deliveree."
  };
}
