const DEFAULT_SETTINGS = {
  deviceId: "yugi-browser",
  intakeUrl: "http://127.0.0.1:3001",
  token: ""
};

const elements = {
  bookingId: document.querySelector("#booking-id"),
  clearLogs: document.querySelector("#clear-logs"),
  connectionState: document.querySelector("#connection-state"),
  copyLogs: document.querySelector("#copy-logs"),
  deviceId: document.querySelector("#device-id"),
  eventType: document.querySelector("#event-type"),
  intakeUrl: document.querySelector("#intake-url"),
  lastSent: document.querySelector("#last-sent"),
  logs: document.querySelector("#logs"),
  result: document.querySelector("#result"),
  save: document.querySelector("#save"),
  status: document.querySelector("#status"),
  summaryBadge: document.querySelector("#summary-badge"),
  summaryText: document.querySelector("#summary-text"),
  testDiscord: document.querySelector("#test-discord"),
  testIntake: document.querySelector("#test-intake"),
  token: document.querySelector("#token")
};

function formatTime(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("id-ID", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit"
  });
}

function formatElapsed(value) {
  if (!value) {
    return undefined;
  }

  const elapsedMs = Math.max(0, Date.now() - new Date(value).getTime());
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds} detik lalu`;
  }

  return `${minutes} menit ${seconds} detik lalu`;
}

function setConnectionState(result) {
  elements.connectionState.classList.remove("ok", "error");

  if (!result) {
    elements.connectionState.textContent = "Idle";
    return;
  }

  if (result.ok) {
    if (result.action === "health_ok") {
      elements.connectionState.textContent = "Connected";
      elements.connectionState.classList.add("ok");
      return;
    }

    if (result.action === "discord_test_sent") {
      elements.connectionState.textContent = "Discord OK";
      elements.connectionState.classList.add("ok");
      return;
    }

    elements.connectionState.textContent = result.deduped ? "Deduped" : "Sent";
    elements.connectionState.classList.add("ok");
    return;
  }

  elements.connectionState.textContent = "Error";
  elements.connectionState.classList.add("error");
}

function formatLogEntry(entry) {
  const at = formatTime(entry.at);
  const details = entry.details && Object.keys(entry.details).length > 0
    ? ` | ${JSON.stringify(entry.details)}`
    : "";

  return `[${at}] ${String(entry.level || "info").toUpperCase()} ${entry.event || "event"} - ${entry.message || ""}${details}`;
}

function formatLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return "Belum ada log.";
  }

  return logs.map(formatLogEntry).join("\n");
}

function humanPageKind(pageKind) {
  const labels = {
    booking_detail: "Detail booking",
    draft_page: "Draft order",
    front_page: "Halaman utama",
    unknown_deliveree_page: "Halaman Deliveree"
  };

  return labels[pageKind] || pageKind || "Belum diketahui";
}

function humanSignal(eventType, status) {
  if (eventType === "order_failed") {
    return "Order gagal";
  }

  if (eventType === "order_created") {
    return "Order dibuat/aktif";
  }

  if (status === "completed") {
    return "Selesai";
  }

  if (["going_to_pickup", "waiting_pickup", "going_to_destination", "arrived_destination"].includes(status)) {
    return "Order berjalan";
  }

  return "Tidak ada sinyal MVP";
}

function inferEventType(status) {
  if (status === "cancelled" || status === "no_driver_found") {
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

function pageStatusFromLog(entry) {
  const details = entry?.details || {};

  if (!["active_page_status_finished", "page_state_finished"].includes(entry?.event) || !details.ok) {
    return undefined;
  }

  return {
    bookingId: details.bookingId,
    driverName: details.driverName,
    eventType: details.eventType || inferEventType(details.status),
    etaText: details.etaText,
    lastHeartbeatAt: details.lastHeartbeatAt || entry.at,
    lastStatusChangeAt: details.statusStartedAt,
    lateText: details.lateText,
    manualTest: entry.event === "active_page_status_finished",
    pageKind: details.pageKind,
    plateNumber: details.plateNumber,
    receivedAt: entry.at,
    source: details.source,
    status: details.status,
    statusText: details.statusText,
    vehicleDescription: details.vehicleDescription
  };
}

function latestPageStatusFromLogs(logs) {
  if (!Array.isArray(logs)) {
    return undefined;
  }

  for (const entry of logs) {
    const pageStatus = pageStatusFromLog(entry);

    if (pageStatus) {
      return pageStatus;
    }
  }

  return undefined;
}

function summaryBadgeClass(pageStatus) {
  if (!pageStatus) {
    return "";
  }

  if (pageStatus.eventType === "order_failed" || pageStatus.status === "cancelled" || pageStatus.status === "no_driver_found") {
    return "fail";
  }

  if (
    pageStatus.eventType === "order_created"
    || [
      "searching_driver",
      "driver_assigned",
      "going_to_pickup",
      "waiting_pickup",
      "going_to_destination",
      "arrived_destination"
    ].includes(pageStatus.status)
  ) {
    return "warn";
  }

  return "ok";
}

function setSummary(pageStatus) {
  elements.summaryBadge.classList.remove("ok", "warn", "fail");

  if (!pageStatus) {
    elements.summaryBadge.textContent = "Belum dicek";
    elements.summaryText.textContent = "Buka halaman Deliveree, lalu klik Test Intake.";
    return;
  }

  const badgeClass = summaryBadgeClass(pageStatus);

  if (badgeClass) {
    elements.summaryBadge.classList.add(badgeClass);
  }

  const booking = pageStatus.bookingId ? `#${pageStatus.bookingId}` : "tanpa booking aktif";
  const status = pageStatus.statusText || pageStatus.status || "-";
  const signal = humanSignal(pageStatus.eventType, pageStatus.status);
  const extra = [
    pageStatus.etaText ? `ETA ${pageStatus.etaText}` : undefined,
    pageStatus.lateText,
    pageStatus.plateNumber ? `Plat ${pageStatus.plateNumber}` : undefined
  ].filter(Boolean).join(". ");
  const heartbeatText = formatElapsed(pageStatus.lastHeartbeatAt || pageStatus.receivedAt);
  const statusChangeText = formatElapsed(pageStatus.lastStatusChangeAt);
  const health = [
    heartbeatText ? `Heartbeat ${heartbeatText}` : undefined,
    statusChangeText ? `status berubah ${statusChangeText}` : undefined
  ].filter(Boolean).join(", ");

  elements.summaryBadge.textContent = signal;
  elements.summaryText.textContent = `${humanPageKind(pageStatus.pageKind)} ${booking}. Status: ${status}.${extra ? ` ${extra}.` : ""}${health ? ` ${health}.` : ""} Source: ${pageStatus.manualTest ? "manual Test Intake" : "heartbeat extension"}.`;
}

async function render() {
  const data = await chrome.storage.local.get({
    ...DEFAULT_SETTINGS,
    extensionLogs: [],
    lastEvent: undefined,
    lastPageStatus: undefined,
    lastResult: undefined
  });

  elements.intakeUrl.value = data.intakeUrl;
  elements.deviceId.value = data.deviceId;
  elements.token.value = data.token;
  const pageStatus = data.lastPageStatus || latestPageStatusFromLogs(data.extensionLogs);

  elements.bookingId.textContent = data.lastEvent?.bookingId || pageStatus?.bookingId || "-";
  elements.status.textContent = data.lastEvent?.status || pageStatus?.status || "-";
  elements.eventType.textContent = data.lastEvent?.eventType || pageStatus?.eventType || "-";
  elements.lastSent.textContent = formatTime(pageStatus?.lastHeartbeatAt || pageStatus?.receivedAt || data.lastResult?.at);
  elements.result.textContent = data.lastResult?.ok
    ? `${data.lastResult.action || "ok"} (${data.lastResult.httpStatus || 200})`
    : data.lastResult?.error || "-";
  elements.logs.value = formatLogs(data.extensionLogs);
  setSummary(pageStatus);
  setConnectionState(data.lastResult);
}

async function saveSettings(options = {}) {
  await chrome.storage.local.set({
    deviceId: elements.deviceId.value.trim() || DEFAULT_SETTINGS.deviceId,
    intakeUrl: elements.intakeUrl.value.trim() || DEFAULT_SETTINGS.intakeUrl,
    token: elements.token.value.trim()
  });

  if (options.renderAfter !== false) {
    await render();
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

async function runPopupTest(button, messageType, busyText, idleText) {
  await saveSettings({
    renderAfter: false
  });
  button.disabled = true;
  button.textContent = busyText;

  try {
    await sendRuntimeMessage({
      type: messageType
    });
  } finally {
    button.disabled = false;
    button.textContent = idleText;
    await render();
  }
}

async function copyLogs() {
  const data = await chrome.storage.local.get({
    extensionLogs: []
  });

  await navigator.clipboard.writeText(formatLogs(data.extensionLogs));
  elements.copyLogs.textContent = "Copied";
  window.setTimeout(() => {
    elements.copyLogs.textContent = "Copy";
  }, 1200);
}

async function clearLogs() {
  await chrome.storage.local.set({
    extensionLogs: []
  });
  await render();
}

elements.save.addEventListener("click", saveSettings);
elements.testIntake.addEventListener("click", () => runPopupTest(
  elements.testIntake,
  "DELIVEREE_TEST_INTAKE",
  "Testing...",
  "Test Intake"
));
elements.testDiscord.addEventListener("click", () => runPopupTest(
  elements.testDiscord,
  "DELIVEREE_TEST_DISCORD",
  "Sending...",
  "Send Discord Test"
));
elements.copyLogs.addEventListener("click", copyLogs);
elements.clearLogs.addEventListener("click", clearLogs);
render();
