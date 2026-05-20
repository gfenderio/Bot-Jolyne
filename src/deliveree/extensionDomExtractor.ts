import { z } from "zod";
import { DELIVEREE_WEB_STATUSES, type DelivereeWebStatus } from "./webClassifier.js";

export const DELIVEREE_EXTENSION_SCHEMA_VERSION = 1;

export const DELIVEREE_EXTENSION_EVENT_TYPES = [
  "order_created",
  "order_failed",
  "driver_retry_detected",
  "driver_retry_clicked",
  "driver_assigned_after_retry",
  "driver_retry_page_changed",
  "driver_retry_paused"
] as const;

export type DelivereeExtensionEventType = (typeof DELIVEREE_EXTENSION_EVENT_TYPES)[number];

export const DELIVEREE_EXTENSION_PAGE_KINDS = [
  "booking_detail",
  "draft_page",
  "front_page",
  "unknown_deliveree_page"
] as const;

export type DelivereeExtensionPageKind = (typeof DELIVEREE_EXTENSION_PAGE_KINDS)[number];

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
  driverName?: string;
  duplicateUrl?: string;
  eventType?: DelivereeExtensionEventType;
  etaMinutes?: number;
  etaText?: string;
  failureReason?: string;
  jobNo?: string;
  lateText?: string;
  observedAt: string;
  pageUrl: string;
  plateNumber?: string;
  retryAttempt?: number;
  retryDelayUsed?: number;
  retryDurationSeconds?: number;
  retryTotalDurationSeconds?: number;
  retryStopReason?: string;
  schemaVersion: typeof DELIVEREE_EXTENSION_SCHEMA_VERSION;
  serviceType?: string;
  status: DelivereeWebStatus;
  statusText?: string;
  totalDistanceKm?: number;
  vehicleDescription?: string;
};

export const delivereeExtensionStatusPayloadSchema = z.object({
  bookingId: z.string().min(1).max(64),
  destinationCount: z.number().int().nonnegative().optional(),
  driverName: z.string().min(1).max(120).optional(),
  duplicateUrl: z.string().url().optional(),
  eventType: z.enum(DELIVEREE_EXTENSION_EVENT_TYPES).optional(),
  etaMinutes: z.number().int().nonnegative().optional(),
  etaText: z.string().min(1).max(40).optional(),
  failureReason: z.string().min(1).max(160).optional(),
  jobNo: z.string().min(1).max(120).optional(),
  lateText: z.string().min(1).max(80).optional(),
  observedAt: z.string().datetime(),
  pageUrl: z.string().url(),
  plateNumber: z.string().min(1).max(24).optional(),
  retryAttempt: z.number().int().nonnegative().optional(),
  retryDelayUsed: z.number().int().nonnegative().optional(),
  retryDurationSeconds: z.number().int().nonnegative().optional(),
  retryTotalDurationSeconds: z.number().int().nonnegative().optional(),
  retryStopReason: z.string().max(160).optional(),
  schemaVersion: z.literal(DELIVEREE_EXTENSION_SCHEMA_VERSION),
  serviceType: z.string().min(1).max(80).optional(),
  status: z.enum(DELIVEREE_WEB_STATUSES),
  statusText: z.string().min(1).max(100).optional(),
  totalDistanceKm: z.number().nonnegative().optional(),
  vehicleDescription: z.string().min(1).max(160).optional()
}).strict();

export type DelivereeExtensionPageStatePayload = {
  bookingId?: string;
  driverName?: string;
  eventType?: DelivereeExtensionEventType;
  etaMinutes?: number;
  etaText?: string;
  failureReason?: string;
  lateText?: string;
  observedAt: string;
  pageKind: DelivereeExtensionPageKind;
  pageUrl: string;
  plateNumber?: string;
  schemaVersion: typeof DELIVEREE_EXTENSION_SCHEMA_VERSION;
  status?: DelivereeWebStatus;
  statusText?: string;
  vehicleDescription?: string;
};

export const delivereeExtensionPageStatePayloadSchema = z.object({
  bookingId: z.string().min(1).max(64).optional(),
  driverName: z.string().min(1).max(120).optional(),
  eventType: z.enum(DELIVEREE_EXTENSION_EVENT_TYPES).optional(),
  etaMinutes: z.number().int().nonnegative().optional(),
  etaText: z.string().min(1).max(40).optional(),
  failureReason: z.string().min(1).max(160).optional(),
  lateText: z.string().min(1).max(80).optional(),
  observedAt: z.string().datetime(),
  pageKind: z.enum(DELIVEREE_EXTENSION_PAGE_KINDS),
  pageUrl: z.string().url(),
  plateNumber: z.string().min(1).max(24).optional(),
  schemaVersion: z.literal(DELIVEREE_EXTENSION_SCHEMA_VERSION),
  status: z.enum(DELIVEREE_WEB_STATUSES).optional(),
  statusText: z.string().min(1).max(100).optional(),
  vehicleDescription: z.string().min(1).max(160).optional()
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

  if (
    hasClass(snapshot, "badge-status--completed")
    || /\bselesai\b/.test(badgeText)
    || /\bbooking\s+[a-z0-9-]+\s+is complete\b/i.test(snapshot.bodyText)
  ) {
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

  if (includesAny(bodyText, ["di tujuan", "di lokasi akhir pada", "arrived at destination"])) {
    return "arrived_destination";
  }

  if (includesAny(bodyText, ["menuju tujuan", "going to destination"])) {
    return "going_to_destination";
  }

  if (includesAny(bodyText, ["menuju penjemputan", "going to pickup"])) {
    return "going_to_pickup";
  }

  if (includesAny(bodyText, ["menunggu penjemputan", "waiting pickup", "waiting for pickup"])) {
    return "waiting_pickup";
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

function detectEventType(status: DelivereeWebStatus): DelivereeExtensionEventType | undefined {
  if (status === "cancelled" || status === "no_driver_found") {
    return "order_failed";
  }

  if (
    status === "searching_driver"
    || status === "driver_assigned"
    || status === "active_booking"
    || status === "going_to_pickup"
    || status === "waiting_pickup"
    || status === "going_to_destination"
    || status === "arrived_destination"
  ) {
    return "order_created";
  }

  return undefined;
}

function detectFailureReason(status: DelivereeWebStatus, snapshot: DelivereeExtensionPageSnapshot) {
  if (status === "cancelled") {
    return optionalString(snapshot.badgeText) ?? "Order dibatalkan.";
  }

  if (status === "no_driver_found") {
    return "Tidak ada pengemudi ditemukan.";
  }

  return undefined;
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

  const completePageMatch = normalizeText(snapshot.bodyText).match(/\bBooking\s+([A-Za-z0-9-]+)\s+is complete\b/i);

  if (completePageMatch) {
    return completePageMatch[1];
  }

  const numericUrlMatch = snapshot.pageUrl.match(/\/bookings\/(\d+)/);
  if (numericUrlMatch?.[1]) {
    return numericUrlMatch[1];
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

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return normalizeText(match[1]);
    }
  }

  return undefined;
}

function findDriverName(snapshot: DelivereeExtensionPageSnapshot) {
  const bodyText = normalizeText(snapshot.bodyText);
  return firstMatch(bodyText, [
    /\bPengemudi\s+(.+?)\s+(?:star|★|Pickup|Small Pickup|Mobil|Van|Suzuki|Daihatsu|Toyota)\b/i,
    /\bYour Driver\s+(.+?)\s+(?:Small Pickup|Pickup|Mobil|Van)\b/i,
    /\bPengemudi:\s*(.+?)\s*Kendaraan:\b/i
  ])?.replace(/^Pengemudi\s+/i, "");
}

function findPlateNumber(snapshot: DelivereeExtensionPageSnapshot) {
  const bodyText = normalizeText(snapshot.bodyText);
  return firstMatch(bodyText, [
    /\b([A-Z]{1,2}\s?\d{3,4}\s?[A-Z]{1,3})\b/i,
    /\bPlat\s*(?:Nomor)?:\s*([A-Z]{1,2}\s?\d{3,4}\s?[A-Z]{1,3})\b/i
  ])?.replace(/\s+/g, "").toUpperCase();
}

function findVehicleDescription(snapshot: DelivereeExtensionPageSnapshot) {
  const bodyText = normalizeText(snapshot.bodyText);
  return firstMatch(bodyText, [
    /\b((?:Pickup|Small Pickup|Mobil|Van)[^#]{0,80}?(?:Suzuki|Daihatsu|Toyota|Mitsubishi|Honda|Isuzu)[^#]{0,40}?)(?:\s+[A-Z]{1,2}\s?\d{3,4}\s?[A-Z]{1,3}|\s+Kode Pemesanan|\s+Contact|\s+visibility)/i,
    /\b((?:Pickup|Small Pickup|Mobil|Van)[^#]{0,80})\s+(?:Kode Pemesanan|Contact|Pengemudi)/i,
    /\bKendaraan:\s*([^\n#]+?)\s*(?:Plat|Plate)\b/i
  ]);
}

function findEta(snapshot: DelivereeExtensionPageSnapshot) {
  const bodyText = normalizeText(snapshot.bodyText);
  const match = bodyText.match(/\b(\d{1,3})\s*(MNT|MIN|MENIT)\b/i);

  if (!match) {
    return {};
  }

  return {
    etaMinutes: Number(match[1]),
    etaText: `${match[1]} ${match[2].toUpperCase()}`
  };
}

function findLateText(snapshot: DelivereeExtensionPageSnapshot) {
  return firstMatch(normalizeText(snapshot.bodyText), [
    /\b(\d+\s*m\s*telat)\b/i,
    /\b(\d+\s*menit\s*telat)\b/i
  ]);
}

export function extractDelivereeExtensionStatus(snapshot: DelivereeExtensionPageSnapshot): DelivereeExtensionStatusPayload {
  const bookingId = findBookingId(snapshot);

  if (!bookingId) {
    throw new Error("Tidak bisa menemukan booking ID Deliveree dari halaman.");
  }

  const status = detectStatus(snapshot);
  const eta = findEta(snapshot);
  const hasDriver = ["driver_assigned", "going_to_pickup", "waiting_pickup", "going_to_destination", "arrived_destination"].includes(status);

  const payload: DelivereeExtensionStatusPayload = {
    bookingId,
    destinationCount: parseInteger(getDetailValue(snapshot, "Tujuan")),
    driverName: hasDriver ? findDriverName(snapshot) : undefined,
    duplicateUrl: findDuplicateUrl(snapshot, bookingId),
    etaMinutes: eta.etaMinutes,
    etaText: eta.etaText,
    eventType: detectEventType(status),
    failureReason: detectFailureReason(status, snapshot),
    jobNo: optionalString(getDetailValue(snapshot, "No. Job")),
    lateText: findLateText(snapshot),
    observedAt: snapshot.observedAt ?? new Date().toISOString(),
    pageUrl: snapshot.pageUrl,
    plateNumber: hasDriver ? findPlateNumber(snapshot) : undefined,
    schemaVersion: DELIVEREE_EXTENSION_SCHEMA_VERSION,
    serviceType: optionalString(getDetailValue(snapshot, "Jenis Layanan")),
    status,
    statusText: optionalString(snapshot.badgeText),
    totalDistanceKm: parseNumber(getDetailValue(snapshot, "Total Jarak")),
    vehicleDescription: hasDriver ? findVehicleDescription(snapshot) : undefined
  };

  return delivereeExtensionStatusPayloadSchema.parse(payload);
}

export function parseDelivereeExtensionStatusPayload(value: unknown) {
  return delivereeExtensionStatusPayloadSchema.parse(value);
}

export function parseDelivereeExtensionPageStatePayload(value: unknown) {
  return delivereeExtensionPageStatePayloadSchema.parse(value);
}
