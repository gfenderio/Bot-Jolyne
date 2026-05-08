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
  intakeUrl: document.querySelector("#intake-url"),
  lastSent: document.querySelector("#last-sent"),
  logs: document.querySelector("#logs"),
  result: document.querySelector("#result"),
  save: document.querySelector("#save"),
  status: document.querySelector("#status"),
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

async function render() {
  const data = await chrome.storage.local.get({
    ...DEFAULT_SETTINGS,
    extensionLogs: [],
    lastEvent: undefined,
    lastResult: undefined
  });

  elements.intakeUrl.value = data.intakeUrl;
  elements.deviceId.value = data.deviceId;
  elements.token.value = data.token;
  elements.bookingId.textContent = data.lastEvent?.bookingId || "-";
  elements.status.textContent = data.lastEvent?.status || "-";
  elements.lastSent.textContent = formatTime(data.lastResult?.at);
  elements.result.textContent = data.lastResult?.ok
    ? `${data.lastResult.action || "ok"} (${data.lastResult.httpStatus || 200})`
    : data.lastResult?.error || "-";
  elements.logs.value = formatLogs(data.extensionLogs);
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
