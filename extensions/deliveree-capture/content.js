(() => {
if (window.__KYOU_DELIVEREE_CAPTURE_LOADED__) {
  return;
}

window.__KYOU_DELIVEREE_CAPTURE_LOADED__ = true;

const SCHEMA_VERSION = 1;
const HEARTBEAT_MS = 15000;
const SEND_DEBOUNCE_MS = 1000;

let lastFingerprint = "";
let lastLogFingerprint = "";
let lastPageStateFingerprint = "";
let debounceTimer;
let heartbeatTimer;
let retryTimer;
let mainObserver = null;
let runtimeMessageListener = null;
let storageChangeListener = null;
let extensionContextDead = false;

function getChromeRuntime() {
  try {
    return typeof chrome !== "undefined" ? chrome.runtime : null;
  } catch {
    return null;
  }
}

function getChromeStorageLocal() {
  try {
    return typeof chrome !== "undefined" ? chrome.storage?.local : null;
  } catch {
    return null;
  }
}

function getChromeStorageChanges() {
  try {
    return typeof chrome !== "undefined" ? chrome.storage?.onChanged : null;
  } catch {
    return null;
  }
}

function isContextInvalidated() {
  if (extensionContextDead) {
    return true;
  }
  try {
    const runtime = getChromeRuntime();
    return !runtime || !runtime.id;
  } catch {
    extensionContextDead = true;
    return true;
  }
}

function checkContextAndCleanup() {
  if (isContextInvalidated()) {
    extensionContextDead = true;
    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (retryTimer) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (mainObserver) {
      mainObserver.disconnect();
      mainObserver = null;
    }
    try {
      const runtime = getChromeRuntime();
      if (runtimeMessageListener && runtime?.onMessage?.removeListener) {
        runtime.onMessage.removeListener(runtimeMessageListener);
      }
    } catch {
      // Extension context is already gone.
    }
    runtimeMessageListener = null;
    try {
      const storageChanges = getChromeStorageChanges();
      if (storageChangeListener && storageChanges?.removeListener) {
        storageChanges.removeListener(storageChangeListener);
      }
    } catch {
      // Extension context is already gone.
    }
    storageChangeListener = null;
    return true;
  }
  return false;
}

let autoRetryEnabled = false;
let retryAttempt = 0;
let retryStartedAt = null;
let retryBookingId = null;
let isRetryPaused = false;

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

function truncateText(value, maxLength) {
  const text = optionalString(value);

  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function findActiveHomepageOrder() {
  const orderItems = Array.from(document.querySelectorAll(".Dropdown-Devina-Group"));
  const order = orderItems.find((item) => /Pemesanan\s+#\w+/i.test(textOf(item)));

  if (!order) {
    return undefined;
  }

  const item = order.closest(".Dropdown-Menu-Item") || order;
  const bookingId = textOf(order.querySelector("b")).match(/Pemesanan\s+#([A-Za-z0-9-]+)/i)?.[1]
    || textOf(order).match(/Pemesanan\s+#([A-Za-z0-9-]+)/i)?.[1];

  if (!bookingId) {
    return undefined;
  }

  const address = optionalString(textOf(order.querySelector("span")));
  const timeLeft = optionalString(textOf(item.querySelector(".Dropdown-Devina-Time b")));
  const subtitle = optionalString(textOf(document.querySelector(".TitleSubtitle-subtitle")));
  const statusText = [subtitle, timeLeft ? `${timeLeft} left` : undefined, address]
    .filter(Boolean)
    .join(" ? ");
  const status = subtitle && normalizeKey(subtitle).includes("mencari")
    ? "searching_driver"
    : "active_booking";

  return {
    address,
    bookingId,
    status,
    statusText: truncateText(statusText, 100),
    timeLeft
  };
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

  const numericPathBookingId = window.location.pathname.match(/\/bookings\/(\d+)/)?.[1];

  if (numericPathBookingId) {
    return numericPathBookingId;
  }

  const pathBookingId = window.location.pathname.match(/\/bookings\/([^/?#]+)/)?.[1];

  if (!pathBookingId || ["new", "book_again"].includes(pathBookingId.toLowerCase())) {
    return undefined;
  }

  return pathBookingId;
}

function isBookingDetailPage() {
  const bookingId = findBookingId();
  return Boolean(bookingId) && /^\/bookings\//.test(window.location.pathname);
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

  if (
    includesAny(bodyText, ["driver", "pengemudi"])
    && includesAny(bodyText, ["plat", "nomor polisi", "kendaraan", "dalam perjalanan", "menuju penjemputan", "arrived at pickup"])
  ) {
    return "driver_assigned";
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

  if (isBookingDetailPage()) {
    return "active_booking";
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
    "active_booking",
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
    /\bPengemudi\s+(.+?)\s+(?:star|Ã¢Ëœâ€¦|Pickup|Small Pickup|Mobil|Van|Suzuki|Daihatsu|Toyota)\b/i,
    /\bYour Driver\s+(.+?)\s+(?:Small Pickup|Pickup|Mobil|Van)\b/i,
    /\bPengemudi:\s*(.+?)\s*Kendaraan:\b/i
  ])?.replace(/^Pengemudi\s+/i, "");
}

function findPlateNumber(bodyText) {
  return firstMatch(bodyText, [
    /\b([A-Z]{1,2}\s?\d{3,4}\s?[A-Z]{1,3})\b/i,
    /\bPlat\s*(?:Nomor)?:\s*([A-Z]{1,2}\s?\d{3,4}\s?[A-Z]{1,3})\b/i
  ])?.replace(/\s+/g, "").toUpperCase();
}

function findVehicleDescription(bodyText) {
  return firstMatch(bodyText, [
    /\b((?:Pickup|Small Pickup|Mobil|Van)[^#]{0,80}?(?:Suzuki|Daihatsu|Toyota|Mitsubishi|Honda|Isuzu)[^#]{0,40}?)(?:\s+[A-Z]{1,2}\s?\d{3,4}\s?[A-Z]{1,3}|\s+Kode Pemesanan|\s+Contact|\s+visibility)/i,
    /\b((?:Pickup|Small Pickup|Mobil|Van)[^#]{0,80})\s+(?:Kode Pemesanan|Contact|Pengemudi)/i,
    /\bKendaraan:\s*([^\n#]+?)\s*(?:Plat|Plate)\b/i
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
  const homepageOrder = findActiveHomepageOrder();

  if (homepageOrder) {
    return {
      bookingId: homepageOrder.bookingId,
      eventType: "order_created",
      failureReason: homepageOrder.address ? truncateText(`Alamat aktif: ${homepageOrder.address}`, 160) : undefined,
      observedAt: new Date().toISOString(),
      pageUrl: new window.URL(`/bookings/${homepageOrder.bookingId}`, window.location.href).toString(),
      schemaVersion: SCHEMA_VERSION,
      status: homepageOrder.status,
      statusText: homepageOrder.statusText
    };
  }

  const bookingId = findBookingId();

  if (!bookingId) {
    return undefined;
  }

  const badgeText = optionalString(textOf(document.querySelector(".badge-status")));
  const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || "");
  const status = detectStatus();
  const eventType = detectEventType(status);
  const eta = findEta(bodyText);

  const hasDriver = ["driver_assigned", "going_to_pickup", "waiting_pickup", "going_to_destination", "arrived_destination"].includes(status);

  return {
    bookingId,
    destinationCount: parseInteger(getDetailValue("Tujuan")),
    driverName: hasDriver ? findDriverName(bodyText) : undefined,
    duplicateUrl: findDuplicateUrl(bookingId),
    etaMinutes: eta.etaMinutes,
    etaText: eta.etaText,
    eventType,
    failureReason: detectFailureReason(status, badgeText),
    jobNo: optionalString(getDetailValue("No. Job")),
    lateText: findLateText(bodyText),
    observedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    plateNumber: hasDriver ? findPlateNumber(bodyText) : undefined,
    schemaVersion: SCHEMA_VERSION,
    serviceType: optionalString(getDetailValue("Jenis Layanan")),
    status,
    statusText: badgeText,
    totalDistanceKm: parseNumber(getDetailValue("Total Jarak")),
    vehicleDescription: hasDriver ? findVehicleDescription(bodyText) : undefined
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
  ) {
    return {
      details,
      event: "draft_page_detected",
      pageKind: "draft_page",
      message: "Draft pemesanan Deliveree terdeteksi. Extension hanya mencatat lokal."
    };
  }

  if (
    path === "/"
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

function safeSendMessage(message) {
  if (extensionContextDead || checkContextAndCleanup()) return;
  try {
    const runtime = getChromeRuntime();
    if (!runtime?.sendMessage) return;
    runtime.sendMessage(message, () => {
      try {
        if (runtime.lastError) {
          // Consume Chrome runtime error so it does not surface as an unchecked callback error.
        }
      } catch {
        extensionContextDead = true;
      }
    });
  } catch {
    extensionContextDead = true;
  }
}

function sendPageState(pageState, options = {}) {
  const fingerprint = fingerprintPageState(pageState);

  if (!options.force && fingerprint === lastPageStateFingerprint) {
    return;
  }

  lastPageStateFingerprint = fingerprint;
  safeSendMessage({
    pageState,
    type: "DELIVEREE_PAGE_STATE"
  });
}

function sendContentLog(level, event, message, details = {}) {
  safeSendMessage({
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
  if (checkContextAndCleanup()) return;
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

  if (!options.forceStatus && fingerprint === lastFingerprint) {
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
  safeSendMessage({
    payload,
    type: "DELIVEREE_STATUS"
  });
}


function sendForcedCurrentStatus(eventType, statusOverride) {
  const status = statusOverride || "searching_driver";
  const isDriverFound = status === "driver_assigned";
  const payload = {
    bookingId: "MOCK-7777",
    destinationCount: 2,
    eventType,
    jobNo: "JB-9999999",
    observedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    retryAttempt,
    schemaVersion: SCHEMA_VERSION,
    serviceType: "Pickup (1 Ton)",
    status,
    statusText: status === "searching_driver"
      ? "Mencari Driver"
      : status === "no_driver_found"
        ? "Tidak bisa menemukan driver"
        : "Driver Ditemukan",
    totalDistanceKm: 14.8,
    ...(isDriverFound ? {
      driverName: "Budi Santoso",
      plateNumber: "B9876CKY",
      vehicleDescription: "Pickup Mitsubishi L300"
    } : {})
  };

  if (eventType === "driver_assigned_after_retry") {
    payload.retryTotalDurationSeconds = retryStartedAt
      ? Math.floor((Date.now() - retryStartedAt.getTime()) / 1000)
      : 0;
  }

  lastFingerprint = "";
  lastPageStateFingerprint = "";
  sendPageState(buildPageStateFromPayload(payload), { force: true });
  safeSendMessage({ payload, type: "DELIVEREE_STATUS" });
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

function stopRetry(reason, eventType) {
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  
  if (retryStartedAt && eventType) {
    const payload = buildPayload();
    if (payload) {
      payload.eventType = eventType;
      payload.retryStopReason = reason;
      payload.retryAttempt = retryAttempt;
      payload.retryTotalDurationSeconds = Math.floor((Date.now() - retryStartedAt.getTime()) / 1000);
      
      safeSendMessage({
        payload,
        type: "DELIVEREE_STATUS"
      });
    }
  }

  retryAttempt = 0;
  retryStartedAt = null;
  retryBookingId = null;
  isRetryPaused = true;
}

function findRetryButton() {
  const buttons = Array.from(document.querySelectorAll("button, .btn"));
  return buttons.find(btn => normalizeKey(textOf(btn)) === "coba pesan kembali" && !btn.disabled && btn.offsetParent !== null);
}

function processAutoRetry(status) {
  if (!autoRetryEnabled) {
    if (retryTimer) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (retryStartedAt) {
      stopRetry("Auto Retry dinonaktifkan", "driver_retry_paused");
    }
    return;
  }

  const currentBookingId = findBookingId();
  if (retryBookingId && currentBookingId !== retryBookingId) {
    stopRetry("Booking ID berubah", "driver_retry_page_changed");
    return;
  }

  if (["captcha_or_security_challenge", "login_required"].includes(status)) {
    if (retryStartedAt) {
      stopRetry("Captcha atau login muncul", "driver_retry_paused");
    }
    return;
  }

  if (status === "driver_assigned" && retryStartedAt) {
    const duration = Math.floor((Date.now() - retryStartedAt.getTime()) / 1000);
    const payload = buildPayload();
    if (payload) {
      payload.eventType = "driver_assigned_after_retry";
      payload.retryTotalDurationSeconds = duration;
      payload.retryAttempt = retryAttempt;
      safeSendMessage({ payload, type: "DELIVEREE_STATUS" });
    }
    stopRetry("Driver ditemukan", null);
    return;
  }

  const isNoDriverModal = status === "no_driver_found";
  const retryButton = findRetryButton();

  if (isNoDriverModal && retryButton) {
    if (!retryStartedAt) {
      retryStartedAt = new Date();
      retryAttempt = 0;
      retryBookingId = currentBookingId;
      isRetryPaused = false;
      
      const payload = buildPayload();
      if (payload) {
        payload.eventType = "driver_retry_detected";
        safeSendMessage({ payload, type: "DELIVEREE_STATUS" });
      }
    }

    if (!retryTimer && !isRetryPaused) {
      const delayMs = Math.floor(Math.random() * (15000 - 8000 + 1)) + 8000;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (checkContextAndCleanup()) return;
        if (!autoRetryEnabled || findBookingId() !== retryBookingId) return;
        
        const btn = findRetryButton();
        if (btn) {
          retryAttempt++;
          const duration = Math.floor((Date.now() - retryStartedAt.getTime()) / 1000);
          
          const payload = buildPayload();
          if (payload) {
            payload.eventType = "driver_retry_clicked";
            payload.retryAttempt = retryAttempt;
            payload.retryDelayUsed = Math.floor(delayMs / 1000);
            payload.retryDurationSeconds = duration;
            safeSendMessage({ payload, type: "DELIVEREE_STATUS" });
          }
          
          btn.click();
        }
      }, delayMs);
    }
  } else if (retryStartedAt && !["searching_driver", "no_driver_found"].includes(status)) {
    stopRetry("Modal hilang atau status berubah", "driver_retry_page_changed");
  }
}

function startObserver() {
  if (!document.body) {
    return;
  }

  if (checkContextAndCleanup()) return;

  const storageLocal = getChromeStorageLocal();
  if (storageLocal?.get) {
    try {
      storageLocal.get({ autoRetry: false }, (data) => {
        if (checkContextAndCleanup()) return;
        autoRetryEnabled = Boolean(data.autoRetry);
      });
    } catch {
      checkContextAndCleanup();
    }
  }

  const storageChanges = getChromeStorageChanges();
  storageChangeListener = (changes, area) => {
    if (checkContextAndCleanup()) return;
    if (area === "local" && changes.autoRetry) {
      autoRetryEnabled = Boolean(changes.autoRetry.newValue);
      processAutoRetry(detectStatus());
    }
  };
  if (storageChanges?.addListener) {
    try {
      storageChanges.addListener(storageChangeListener);
    } catch {
      storageChangeListener = null;
      checkContextAndCleanup();
    }
  }

  scheduleSend();
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    if (checkContextAndCleanup()) return;
    sendCurrentStatus({
      forcePageState: true
    });
  }, HEARTBEAT_MS);

  mainObserver = new MutationObserver(() => {
    if (checkContextAndCleanup()) return;
    scheduleSend();
    processAutoRetry(detectStatus());
  });
  
  mainObserver.observe(document.body, {
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

const runtime = getChromeRuntime();
if (runtime?.onMessage?.addListener) {
  runtimeMessageListener = (message, _sender, sendResponse) => {
    if (checkContextAndCleanup()) return;
    if (message?.type === "DELIVEREE_COLLECT_PAGE_STATE") {
      sendResponse(collectCurrentPageState());
      return true;
    }

    if (message?.type === "DELIVEREE_DISABLE_AUTO_RETRY") {
      autoRetryEnabled = false;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (retryStartedAt) {
        stopRetry(message.reason || "Auto Retry dimatikan dari Discord", "driver_retry_paused");
      }
      sendResponse({ ok: true });
      return true;
    }

  if (message?.type === "DELIVEREE_SIMULATE_MODAL") {
    lastFingerprint = "";
    lastPageStateFingerprint = "";
    lastLogFingerprint = "";

    // Clean up any existing simulated modal first
    const existing = document.getElementById("simulated-driver-modal-overlay");
    if (existing) existing.remove();

    const styleId = "simulated-modal-style";
    if (!document.getElementById(styleId)) {
      const styleEl = document.createElement("style");
      styleEl.id = styleId;
      styleEl.textContent = `
        @keyframes modalAppear {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(styleEl);
    }

    const existingMock = document.getElementById("simulated-mock-booking");
    if (existingMock) existingMock.remove();

    const mockHtml = `
      <div id="simulated-mock-booking" style="opacity: 0; pointer-events: none; position: absolute; z-index: -1;">
        <h2 class="title">#MOCK-7777</h2>
        <div class="DetailBooking__Other">
          <table>
            <tr>
              <td>Jenis Layanan</td>
              <td>Pickup (1 Ton)</td>
            </tr>
            <tr>
              <td>Total Jarak</td>
              <td>14.8 km</td>
            </tr>
            <tr>
              <td>Tujuan</td>
              <td>2</td>
            </tr>
            <tr>
              <td>No. Job</td>
              <td>JB-9999999</td>
            </tr>
          </table>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', mockHtml);

    const modalHtml = `
      <div id="simulated-driver-modal-overlay" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(17, 24, 39, 0.7); backdrop-filter: blur(4px); z-index: 999999; display: flex; align-items: center; justify-content: center; font-family: system-ui, -apple-system, sans-serif;">
        <div id="simulated-modal-card" style="background: white; border-radius: 16px; padding: 32px; width: 90%; max-width: 400px; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04); text-align: center; border: 1px solid #e5e7eb; animation: modalAppear 0.3s cubic-bezier(0.16, 1, 0.3, 1);">
          <div id="simulated-modal-icon" style="width: 56px; height: 56px; background: #fee2e2; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px;">
            <svg style="width: 28px; height: 28px; color: #ef4444;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h3 id="simulated-modal-title" style="font-size: 1.25rem; font-weight: 700; color: #111827; margin: 0 0 8px; line-height: 1.5;">Tidak bisa menemukan driver</h3>
          <p id="simulated-modal-desc" style="font-size: 0.875rem; color: #6b7280; margin: 0 0 24px; line-height: 1.5;">Maaf, saat ini seluruh pengemudi kami sedang sibuk melayani pemesanan lain. Silakan coba memesan kembali.</p>
          <div id="simulated-modal-actions" style="display: flex; flex-direction: column; gap: 8px;">
            <button id="simulated-retry-btn" class="btn" style="background: #16a34a; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 0.875rem; cursor: pointer; transition: background 0.2s; box-shadow: 0 4px 6px -1px rgba(22, 163, 74, 0.2);">Coba Pesan Kembali</button>
            <button id="simulated-close-btn" style="background: transparent; color: #4b5563; border: 1px solid #d1d5db; padding: 12px 24px; border-radius: 8px; font-weight: 500; font-size: 0.875rem; cursor: pointer; transition: background 0.2s, color 0.2s;">Tutup</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const overlay = document.getElementById("simulated-driver-modal-overlay");
    const iconContainer = document.getElementById("simulated-modal-icon");
    const title = document.getElementById("simulated-modal-title");
    const desc = document.getElementById("simulated-modal-desc");
    const actions = document.getElementById("simulated-modal-actions");
    const retryBtn = document.getElementById("simulated-retry-btn");
    const closeBtn = document.getElementById("simulated-close-btn");
    const searchDurationMs = 60000;
    const autoRetryDelayMs = 1000;

    const closeHandler = () => overlay.remove();
    closeBtn.addEventListener("click", closeHandler);

    function renderSearching(messageText) {
      actions.style.display = "none";
      iconContainer.style.background = "#f0fdf4";
      iconContainer.innerHTML = `
        <div style="width: 28px; height: 28px; border: 3px solid #f3f3f3; border-top: 3px solid #16a34a; border-radius: 50%; animation: spin 1s linear infinite;"></div>
      `;
      title.textContent = "Mencari Driver...";
      desc.textContent = messageText || "Sedang mencari pengemudi di sekitar Anda...";
    }

    function renderNoDriver() {
      iconContainer.style.background = "#fee2e2";
      iconContainer.innerHTML = `
        <svg style="width: 28px; height: 28px; color: #ef4444;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      `;
      title.textContent = "Tidak bisa menemukan driver";
      desc.textContent = "Maaf, saat ini seluruh pengemudi kami sedang sibuk melayani pemesanan lain. Silakan coba memesan kembali.";
      actions.style.display = "flex";
      retryBtn.disabled = false;
      closeBtn.disabled = false;
      sendForcedCurrentStatus("driver_retry_detected", "no_driver_found");

      if (autoRetryEnabled) {
        window.setTimeout(() => {
          if (!document.getElementById("simulated-driver-modal-overlay")) return;
          retryBtn.click();
        }, autoRetryDelayMs);
      }
    }

    function renderDriverFound() {
      actions.style.display = "none";
      iconContainer.style.background = "#dcfce7";
      iconContainer.innerHTML = `
        <svg style="width: 28px; height: 28px; color: #16a34a;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      `;
      title.textContent = "Driver Ditemukan!";
      desc.innerHTML = `
        <strong>Pengemudi:</strong> Budi Santoso<br>
        <strong>Kendaraan:</strong> Pickup Mitsubishi L300<br>
        <strong>Plat Nomor:</strong> B 9876 CKY
      `;
      sendForcedCurrentStatus("driver_assigned_after_retry", "driver_assigned");
      window.setTimeout(() => overlay.remove(), 10000);
    }

    function startSearch(afterSearch) {
      renderSearching("Sedang mencari pengemudi di sekitar Anda...");
      sendForcedCurrentStatus("order_created", "searching_driver");
      window.setTimeout(() => {
        if (!document.getElementById("simulated-driver-modal-overlay")) return;
        afterSearch();
      }, searchDurationMs);
    }

    retryBtn.addEventListener("click", () => {
      retryAttempt += 1;
      retryStartedAt = retryStartedAt || new Date();
      sendForcedCurrentStatus("driver_retry_clicked", "no_driver_found");
      startSearch(() => {
        if (message.scenario === "success" && retryAttempt >= 1) {
          renderDriverFound();
          return;
        }

        renderNoDriver();
      });
    });

    retryAttempt = 0;
    retryStartedAt = new Date();
    retryBookingId = "MOCK-7777";
    isRetryPaused = false;
    startSearch(renderNoDriver);

    sendResponse({ ok: true });
    return true;
  }

  return false;
  };

  try {
    runtime.onMessage.addListener(runtimeMessageListener);
  } catch {
    runtimeMessageListener = null;
    checkContextAndCleanup();
  }
}
})();

