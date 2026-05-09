const SCHEMA_VERSION = 1;
const HEARTBEAT_MS = 15000;
const SEND_DEBOUNCE_MS = 1000;

let lastFingerprint = "";
let lastLogFingerprint = "";
let lastPageStateFingerprint = "";
let debounceTimer;
let heartbeatTimer;

function textOf(element) {
  return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function includesAny(text, candidates) {
  return candidates.some((candidate) => text.includes(candidate));
}

function getDetailValue(label) {
  const expected = normalizeKey(label);
  const rows = Array.from(document.querySelectorAll(".DetailBooking__Other tr, .DetailBooking-FormGroup table tr"));

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll("td"));

    if (cells.length >= 2 && normalizeKey(textOf(cells[0])) === expected) {
      return textOf(cells[1]) || undefined;
    }
  }

  return undefined;
}

function parseNumber(value) {
  const match = (value || "").match(/[\d,.]+/);

  if (!match) {
    return undefined;
  }

  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseInteger(value) {
  const parsed = parseNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function findBookingId() {
  const detailBookingId = getDetailValue("Kode Pemesanan");

  if (detailBookingId) {
    return detailBookingId;
  }

  const titleMatch = textOf(document.querySelector("h2.title")).match(/#([A-Za-z0-9-]+)/);

  if (titleMatch) {
    return titleMatch[1];
  }

  const completePageMatch = textOf(document.body).match(/\bBooking\s+([A-Za-z0-9-]+)\s+is complete\b/i);

  if (completePageMatch) {
    return completePageMatch[1];
  }

  const pathBookingId = window.location.pathname.match(/\/bookings\/([^/?#]+)/)?.[1];

  if (!pathBookingId || ["new", "book_again"].includes(pathBookingId.toLowerCase())) {
    return undefined;
  }

  return pathBookingId;
}

function findDuplicateUrl(bookingId) {
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const duplicate = anchors.find((anchor) => {
    const href = String(anchor.getAttribute("href") || "").toLowerCase();
    return href.includes(`/bookings/${bookingId.toLowerCase()}/book_again/`) || href.includes("/book_again/");
  });

  if (!duplicate) {
    return undefined;
  }

  try {
    return new window.URL(duplicate.getAttribute("href") || "", window.location.href).toString();
  } catch {
    return undefined;
  }
}

function detectStatus() {
  const badge = document.querySelector(".badge-status");
  const badgeText = normalizeKey(textOf(badge));
  const bodyText = normalizeKey(document.body?.innerText || document.body?.textContent || "");

  if (badge?.classList.contains("badge-status--canceled") || /\bbatal\b/.test(badgeText)) {
    return "cancelled";
  }

  if (
    badge?.classList.contains("badge-status--completed")
    || /\bselesai\b/.test(badgeText)
    || /\bbooking\s+[a-z0-9-]+\s+is complete\b/i.test(document.body?.innerText || document.body?.textContent || "")
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

function detectEventType(status) {
  if (["cancelled", "no_driver_found"].includes(status)) {
    return "order_failed";
  }

  if ([
    "searching_driver",
    "driver_assigned",
    "going_to_pickup",
    "waiting_pickup",
    "going_to_destination",
    "arrived_destination"
  ].includes(status)) {
    return "order_created";
  }

  return undefined;
}

function detectFailureReason(status, statusText) {
  if (status === "cancelled") {
    return optionalString(statusText) || "Order dibatalkan.";
  }

  if (status === "no_driver_found") {
    return "Tidak ada pengemudi ditemukan.";
  }

  return undefined;
}

function optionalString(value) {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return normalizeText(match[1]);
    }
  }

  return undefined;
}

function findDriverName(bodyText) {
  return firstMatch(bodyText, [
    /\bPengemudi\s+(.+?)\s+(?:star|★|Pickup|Small Pickup|Mobil|Van|Suzuki|Daihatsu|Toyota)\b/i,
    /\bYour Driver\s+(.+?)\s+(?:Small Pickup|Pickup|Mobil|Van)\b/i
  ])?.replace(/^Pengemudi\s+/i, "");
}

function findPlateNumber(bodyText) {
  return firstMatch(bodyText, [
    /\b([A-Z]{1,2}\s?\d{3,4}\s?[A-Z]{1,3})\b/i
  ])?.replace(/\s+/g, "").toUpperCase();
}

function findVehicleDescription(bodyText) {
  return firstMatch(bodyText, [
    /\b((?:Pickup|Small Pickup|Mobil|Van)[^#]{0,80}?(?:Suzuki|Daihatsu|Toyota|Mitsubishi|Honda|Isuzu)[^#]{0,40}?)(?:\s+[A-Z]{1,2}\s?\d{3,4}\s?[A-Z]{1,3}|\s+Kode Pemesanan|\s+Contact|\s+visibility)/i,
    /\b((?:Pickup|Small Pickup|Mobil|Van)[^#]{0,80})\s+(?:Kode Pemesanan|Contact|Pengemudi)/i
  ]);
}

function findEta(bodyText) {
  const match = bodyText.match(/\b(\d{1,3})\s*(MNT|MIN|MENIT)\b/i);

  if (!match) {
    return {};
  }

  return {
    etaMinutes: Number(match[1]),
    etaText: `${match[1]} ${match[2].toUpperCase()}`
  };
}

function findLateText(bodyText) {
  return firstMatch(bodyText, [
    /\b(\d+\s*m\s*telat)\b/i,
    /\b(\d+\s*menit\s*telat)\b/i
  ]);
}

function buildPayload() {
  const bookingId = findBookingId();

  if (!bookingId) {
    return undefined;
  }

  const badgeText = optionalString(textOf(document.querySelector(".badge-status")));
  const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || "");
  const status = detectStatus();
  const eventType = detectEventType(status);
  const eta = findEta(bodyText);

  return {
    bookingId,
    destinationCount: parseInteger(getDetailValue("Tujuan")),
    driverName: findDriverName(bodyText),
    duplicateUrl: findDuplicateUrl(bookingId),
    etaMinutes: eta.etaMinutes,
    etaText: eta.etaText,
    eventType,
    failureReason: detectFailureReason(status, badgeText),
    jobNo: optionalString(getDetailValue("No. Job")),
    lateText: findLateText(bodyText),
    observedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    plateNumber: findPlateNumber(bodyText),
    schemaVersion: SCHEMA_VERSION,
    serviceType: optionalString(getDetailValue("Jenis Layanan")),
    status,
    statusText: badgeText,
    totalDistanceKm: parseNumber(getDetailValue("Total Jarak")),
    vehicleDescription: findVehicleDescription(bodyText)
  };
}

function getKnownPageState() {
  const path = window.location.pathname;
  const search = window.location.search;
  const bodyText = normalizeKey(document.body?.innerText || document.body?.textContent || "");
  const details = {
    path,
    search
  };

  if (
    (path === "/" || path === "/bookings/new")
    && (
      document.querySelector("#front-page-wrapper, #front-page-card-pesan-kendaraan")
      || includesAny(bodyText, ["layanan utama", "pesanan terbaru", "pesan kendaraan"])
    )
  ) {
    return {
      details,
      event: "front_page_detected",
      pageKind: "front_page",
      message: "Halaman utama Deliveree terdeteksi. Belum ada booking ID aktif untuk dikirim."
    };
  }

  if (
    path === "/bookings/new"
    && (
      new window.URLSearchParams(search).get("ftl") === "true"
      || document.querySelector(".BookingWizard, #step-wrapper")
      || includesAny(bodyText, ["1. rute", "2. layanan", "3. rincian", "pesan pengemudi"])
    )
  ) {
    return {
      details,
      event: "draft_page_detected",
      pageKind: "draft_page",
      message: "Draft pemesanan Deliveree terdeteksi. Extension hanya mencatat lokal dan tidak mengirim ke Jolyne."
    };
  }

  return undefined;
}

function buildPageStateFromPayload(payload) {
  return {
    bookingId: payload.bookingId,
    driverName: payload.driverName,
    eventType: payload.eventType,
    etaMinutes: payload.etaMinutes,
    etaText: payload.etaText,
    failureReason: payload.failureReason,
    lateText: payload.lateText,
    observedAt: payload.observedAt,
    pageKind: "booking_detail",
    pageUrl: payload.pageUrl,
    plateNumber: payload.plateNumber,
    schemaVersion: SCHEMA_VERSION,
    status: payload.status,
    statusText: payload.statusText,
    vehicleDescription: payload.vehicleDescription
  };
}

function buildIdlePageState(pageKind) {
  return {
    observedAt: new Date().toISOString(),
    pageKind,
    pageUrl: window.location.href,
    schemaVersion: SCHEMA_VERSION
  };
}

function fingerprintPayload(payload) {
  return [
    payload.eventType || "no_event",
    payload.bookingId,
    payload.status,
    payload.duplicateUrl || "",
    payload.serviceType || "",
    payload.totalDistanceKm ?? "",
    payload.destinationCount ?? "",
    payload.jobNo || "",
    payload.etaText || "",
    payload.lateText || "",
    payload.plateNumber || ""
  ].join("|");
}

function fingerprintPageState(pageState) {
  return [
    pageState.pageKind,
    pageState.bookingId || "",
    pageState.status || "",
    pageState.eventType || "",
    pageState.etaText || "",
    pageState.lateText || "",
    pageState.plateNumber || "",
    pageState.pageUrl
  ].join("|");
}

function sendPageState(pageState, options = {}) {
  const fingerprint = fingerprintPageState(pageState);

  if (!options.force && fingerprint === lastPageStateFingerprint) {
    return;
  }

  lastPageStateFingerprint = fingerprint;
  chrome.runtime.sendMessage({
    pageState,
    type: "DELIVEREE_PAGE_STATE"
  });
}

function sendContentLog(level, event, message, details = {}) {
  chrome.runtime.sendMessage({
    details,
    event,
    level,
    message,
    type: "DELIVEREE_LOG"
  });
}

function sendContentLogOnce(fingerprint, level, event, message, details = {}) {
  if (lastLogFingerprint === fingerprint) {
    return;
  }

  lastLogFingerprint = fingerprint;
  sendContentLog(level, event, message, details);
}

function sendCurrentStatus(options = {}) {
  let payload;

  try {
    payload = buildPayload();
  } catch (error) {
    sendContentLogOnce(
      `extract-error:${window.location.pathname}`,
      "error",
      "extract_failed",
      "Gagal membaca halaman Deliveree.",
      {
        error: error instanceof Error ? error.message : "unknown_error",
        path: window.location.pathname
      }
    );
    return;
  }

  if (!payload) {
    const pageState = getKnownPageState();

    if (pageState) {
      sendPageState(buildIdlePageState(pageState.pageKind), {
        force: options.forcePageState
      });
      sendContentLogOnce(
        `${pageState.event}:${window.location.pathname}:${window.location.search}`,
        "info",
        pageState.event,
        pageState.message,
        pageState.details
      );
      return;
    }

    sendPageState(buildIdlePageState("unknown_deliveree_page"), {
      force: options.forcePageState
    });
    sendContentLogOnce(
      `no-booking:${window.location.pathname}:${window.location.search}`,
      "warning",
      "booking_not_detected",
      "Halaman Deliveree terbuka, tapi booking ID belum bisa dibaca.",
      {
        path: window.location.pathname,
        search: window.location.search
      }
    );
    return;
  }

  sendPageState(buildPageStateFromPayload(payload), {
    force: options.forcePageState
  });

  const fingerprint = fingerprintPayload(payload);

  if (fingerprint === lastFingerprint) {
    return;
  }

  if (!payload.eventType) {
    lastFingerprint = fingerprint;
    sendContentLogOnce(
      `non-mvp:${fingerprint}`,
      "info",
      "status_logged_only",
      "Status Deliveree terbaca, tapi bukan sinyal MVP untuk Discord.",
      {
        bookingId: payload.bookingId,
        status: payload.status
      }
    );
    return;
  }

  lastFingerprint = fingerprint;
  chrome.runtime.sendMessage({
    payload,
    type: "DELIVEREE_STATUS"
  });
}

function collectCurrentPageState() {
  try {
    const payload = buildPayload();

    if (payload) {
      return {
        ok: true,
        pageState: buildPageStateFromPayload(payload),
        source: "booking_payload"
      };
    }

    const pageState = getKnownPageState();

    if (pageState) {
      return {
        ok: true,
        pageState: buildIdlePageState(pageState.pageKind),
        source: pageState.event
      };
    }

    return {
      ok: true,
      pageState: buildIdlePageState("unknown_deliveree_page"),
      source: "unknown_deliveree_page"
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "unknown_error",
      ok: false
    };
  }
}

function scheduleSend() {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(sendCurrentStatus, SEND_DEBOUNCE_MS);
}

function startObserver() {
  if (!document.body) {
    return;
  }

  scheduleSend();
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    sendCurrentStatus({
      forcePageState: true
    });
  }, HEARTBEAT_MS);

  const observer = new MutationObserver(scheduleSend);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

if (document.body) {
  startObserver();
} else {
  window.addEventListener("DOMContentLoaded", startObserver, {
    once: true
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "DELIVEREE_COLLECT_PAGE_STATE") {
    return false;
  }

  sendResponse(collectCurrentPageState());
  return true;
});
