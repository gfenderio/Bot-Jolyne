import { z } from "zod";
import { DELIVEREE_WEB_STATUSES, type DelivereeWebStatus } from "./webClassifier.js";

export const DELIVEREE_EXTENSION_SCHEMA_VERSION = 1;

export type DelivereeExtensionAnchorSnapshot = {
  href: string;
  text?: string;
};

export type DelivereeExtensionDetailRowSnapshot = {
  label: string;
  value: string;
};

export type DelivereeExtensionPageSnapshot = {
  anchors?: DelivereeExtensionAnchorSnapshot[];
  badgeClassNames?: string[];
  badgeText?: string;
  bodyText: string;
  detailRows?: DelivereeExtensionDetailRowSnapshot[];
  observedAt?: string;
  pageUrl: string;
  titleText?: string;
};

export type DelivereeExtensionStatusPayload = {
  bookingId: string;
  destinationCount?: number;
  duplicateUrl?: string;
  jobNo?: string;
  observedAt: string;
  pageUrl: string;
  schemaVersion: typeof DELIVEREE_EXTENSION_SCHEMA_VERSION;
  serviceType?: string;
  status: DelivereeWebStatus;
  statusText?: string;
  totalDistanceKm?: number;
};

export const delivereeExtensionStatusPayloadSchema = z.object({
  bookingId: z.string().min(1).max(64),
  destinationCount: z.number().int().nonnegative().optional(),
  duplicateUrl: z.string().url().optional(),
  jobNo: z.string().min(1).max(120).optional(),
  observedAt: z.string().datetime(),
  pageUrl: z.string().url(),
  schemaVersion: z.literal(DELIVEREE_EXTENSION_SCHEMA_VERSION),
  serviceType: z.string().min(1).max(80).optional(),
  status: z.enum(DELIVEREE_WEB_STATUSES),
  statusText: z.string().min(1).max(100).optional(),
  totalDistanceKm: z.number().nonnegative().optional()
}).strict();

function normalizeText(value: string | undefined) {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value: string | undefined) {
  return normalizeText(value).toLowerCase();
}

function hasClass(snapshot: DelivereeExtensionPageSnapshot, className: string) {
  return (snapshot.badgeClassNames ?? []).some((candidate) => candidate.split(/\s+/).includes(className));
}

function includesAny(text: string, candidates: string[]) {
  return candidates.some((candidate) => text.includes(candidate));
}

function detectStatus(snapshot: DelivereeExtensionPageSnapshot): DelivereeWebStatus {
  const badgeText = normalizeKey(snapshot.badgeText);
  const bodyText = normalizeKey(snapshot.bodyText);

  if (hasClass(snapshot, "badge-status--canceled") || /\bbatal\b/.test(badgeText)) {
    return "cancelled";
  }

  if (hasClass(snapshot, "badge-status--completed") || /\bselesai\b/.test(badgeText)) {
    return "completed";
  }

  if (includesAny(bodyText, ["captcha", "security check", "verifikasi keamanan"])) {
    return "captcha_or_security_challenge";
  }

  if (includesAny(bodyText, ["masuk", "login"]) && includesAny(bodyText, ["password", "email"])) {
    return "login_required";
  }

  if (bodyText.includes("tidak bisa menemukan driver")) {
    return "no_driver_found";
  }

  if (includesAny(bodyText, ["memilih", "mencari pengemudi", "tidak ada info pengemudi", "mengonfirmasi"])) {
    return "searching_driver";
  }

  if (
    includesAny(bodyText, ["driver", "pengemudi"])
    && includesAny(bodyText, ["plat", "kendaraan", "dalam perjalanan", "arrived", "pickup"])
  ) {
    return "driver_assigned";
  }

  if (includesAny(bodyText, ["1. rute", "2. layanan", "3. rincian", "pesan pengemudi"])) {
    return "draft_prepared";
  }

  return "unknown";
}

function getDetailValue(snapshot: DelivereeExtensionPageSnapshot, label: string) {
  const expected = normalizeKey(label);
  const row = (snapshot.detailRows ?? []).find((candidate) => normalizeKey(candidate.label) === expected);
  const value = normalizeText(row?.value);
  return value || undefined;
}

function parseNumber(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const match = value.match(/[\d,.]+/);

  if (!match) {
    return undefined;
  }

  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseInteger(value: string | undefined) {
  const parsed = parseNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function findBookingId(snapshot: DelivereeExtensionPageSnapshot) {
  const detailBookingId = getDetailValue(snapshot, "Kode Pemesanan");

  if (detailBookingId) {
    return detailBookingId;
  }

  const titleMatch = normalizeText(snapshot.titleText).match(/#([A-Za-z0-9-]+)/);

  if (titleMatch) {
    return titleMatch[1];
  }

  const urlMatch = snapshot.pageUrl.match(/\/bookings\/([^/?#]+)/);
  const pathBookingId = urlMatch?.[1];

  if (!pathBookingId || ["new", "book_again"].includes(pathBookingId.toLowerCase())) {
    return undefined;
  }

  return pathBookingId;
}

function normalizeUrl(value: string, baseUrl: string) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function findDuplicateUrl(snapshot: DelivereeExtensionPageSnapshot, bookingId: string) {
  const anchors = snapshot.anchors ?? [];
  const duplicate = anchors.find((anchor) => {
    const href = anchor.href.toLowerCase();
    return href.includes(`/bookings/${bookingId.toLowerCase()}/book_again/`) || href.includes("/book_again/");
  });

  return duplicate ? normalizeUrl(duplicate.href, snapshot.pageUrl) : undefined;
}

function optionalString(value: string | undefined) {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

export function extractDelivereeExtensionStatus(snapshot: DelivereeExtensionPageSnapshot): DelivereeExtensionStatusPayload {
  const bookingId = findBookingId(snapshot);

  if (!bookingId) {
    throw new Error("Tidak bisa menemukan booking ID Deliveree dari halaman.");
  }

  const payload: DelivereeExtensionStatusPayload = {
    bookingId,
    destinationCount: parseInteger(getDetailValue(snapshot, "Tujuan")),
    duplicateUrl: findDuplicateUrl(snapshot, bookingId),
    jobNo: optionalString(getDetailValue(snapshot, "No. Job")),
    observedAt: snapshot.observedAt ?? new Date().toISOString(),
    pageUrl: snapshot.pageUrl,
    schemaVersion: DELIVEREE_EXTENSION_SCHEMA_VERSION,
    serviceType: optionalString(getDetailValue(snapshot, "Jenis Layanan")),
    status: detectStatus(snapshot),
    statusText: optionalString(snapshot.badgeText),
    totalDistanceKm: parseNumber(getDetailValue(snapshot, "Total Jarak"))
  };

  return delivereeExtensionStatusPayloadSchema.parse(payload);
}

export function parseDelivereeExtensionStatusPayload(value: unknown) {
  return delivereeExtensionStatusPayloadSchema.parse(value);
}
