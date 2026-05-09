const SCHEMA_VERSION = 1;
const SEND_DEBOUNCE_MS = 1000;

let lastFingerprint = "";
let lastLogFingerprint = "";
let debounceTimer;

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

  if (badge?.classList.contains("badge-status--completed") || /\bselesai\b/.test(badgeText)) {
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

function detectEventType(status) {
  if (["cancelled", "no_driver_found"].includes(status)) {
    return "order_failed";
  }

  if (["searching_driver", "driver_assigned"].includes(status)) {
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

function buildPayload() {
  const bookingId = findBookingId();

  if (!bookingId) {
    return undefined;
  }

  const badgeText = optionalString(textOf(document.querySelector(".badge-status")));
  const status = detectStatus();
  const eventType = detectEventType(status);

  return {
    bookingId,
    destinationCount: parseInteger(getDetailValue("Tujuan")),
    duplicateUrl: findDuplicateUrl(bookingId),
    eventType,
    failureReason: detectFailureReason(status, badgeText),
    jobNo: optionalString(getDetailValue("No. Job")),
    observedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    schemaVersion: SCHEMA_VERSION,
    serviceType: optionalString(getDetailValue("Jenis Layanan")),
    status,
    statusText: badgeText,
    totalDistanceKm: parseNumber(getDetailValue("Total Jarak"))
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
    path === "/bookings/new"
    && (
      document.querySelector("#front-page-wrapper, #front-page-card-pesan-kendaraan")
      || includesAny(bodyText, ["layanan utama", "pesanan terbaru", "pesan kendaraan"])
    )
  ) {
    return {
      details,
      event: "front_page_detected",
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
      message: "Draft pemesanan Deliveree terdeteksi. Extension hanya mencatat lokal dan tidak mengirim ke Jolyne."
    };
  }

  return undefined;
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
    payload.jobNo || ""
  ].join("|");
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

function sendCurrentStatus() {
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
      sendContentLogOnce(
        `${pageState.event}:${window.location.pathname}:${window.location.search}`,
        "info",
        pageState.event,
        pageState.message,
        pageState.details
      );
      return;
    }

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

function scheduleSend() {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(sendCurrentStatus, SEND_DEBOUNCE_MS);
}

function startObserver() {
  if (!document.body) {
    return;
  }

  scheduleSend();

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
