const DEFAULT_SETTINGS = {
  autoRetry: false,
  deviceId: "yugi-browser",
  enabled: true,
  intakeUrl: "http://127.0.0.1:3001",
  token: ""
};

const elements = {
  autoRetry: document.querySelector("#auto-retry"),
  closeHistory: document.querySelector("#close-history"),
  deviceId: document.querySelector("#device-id"),
  enabled: document.querySelector("#enabled"),
  historyPanel: document.querySelector("#history-panel"),
  intakeUrl: document.querySelector("#intake-url"),
  modeBadge: document.querySelector("#mode-badge"),
  openHistory: document.querySelector("#open-history"),
  retryCard: document.querySelector("#retry-card"),
  save: document.querySelector("#save"),
  scanHistory: document.querySelector("#scan-history"),
  testDiscord: document.querySelector("#test-discord"),
  testIntake: document.querySelector("#test-intake"),
  testMenu: document.querySelector("#test-menu"),
  testMenuToggle: document.querySelector("#test-menu-toggle"),
  testModalSuccess: document.querySelector("#test-modal-success"),
  testModalFail: document.querySelector("#test-modal-fail"),
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
    month: "2-digit",
    second: "2-digit"
  });
}

function updateModeControls() {
  const enabled = elements.enabled.checked;

  if (!enabled) {
    elements.autoRetry.checked = false;
  }

  elements.autoRetry.disabled = !enabled;
  elements.retryCard.classList.toggle("toggle-card--disabled", !enabled);
  elements.testMenuToggle.disabled = !enabled;

  if (!enabled) {
    hideTestMenu();
  }

  elements.modeBadge.classList.remove(
    "mode-badge--retry",
    "mode-badge--inactive",
    "mode-badge--open"
  );

  if (!enabled) {
    elements.modeBadge.textContent = "Nonaktif";
    elements.modeBadge.classList.add("mode-badge--inactive");
    return;
  }

  if (elements.autoRetry.checked) {
    elements.modeBadge.textContent = "Auto Retry Aktif";
    elements.modeBadge.classList.add("mode-badge--retry");
    return;
  }

  elements.modeBadge.textContent = "Siap Pantau";
  elements.modeBadge.classList.add("mode-badge--open");
}

function getLogClass(level) {
  if (level === "error") return "is-error";
  if (level === "warn") return "is-searching";
  return "is-success";
}

function renderLogs(logs) {
  const items = Array.isArray(logs) ? logs : [];
  elements.scanHistory.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "scan-history__empty";
    empty.textContent = "Belum ada aktivitas.";
    elements.scanHistory.appendChild(empty);
    return;
  }

  for (const entry of items.slice(0, 10)) {
    const item = document.createElement("li");
    item.className = `scan-history__item ${getLogClass(entry.level)}`;

    const title = document.createElement("strong");
    title.textContent = entry.event || "Event";

    const meta = document.createElement("span");
    const details = entry.details && Object.keys(entry.details).length > 0
      ? ` | ${JSON.stringify(entry.details)}`
      : "";
    meta.textContent = `${formatTime(entry.at)} | ${entry.message || ""}${details}`;

    item.append(title, meta);
    elements.scanHistory.appendChild(item);
  }
}

async function render() {
  const data = await chrome.storage.local.get({
    ...DEFAULT_SETTINGS,
    extensionLogs: []
  });

  elements.intakeUrl.value = data.intakeUrl;
  elements.deviceId.value = data.deviceId;
  elements.token.value = data.token;
  elements.enabled.checked = Boolean(data.enabled);
  elements.autoRetry.checked = elements.enabled.checked && Boolean(data.autoRetry);

  updateModeControls();
  renderLogs(data.extensionLogs);
}

async function saveSettings(options = {}) {
  await chrome.storage.local.set({
    autoRetry: elements.enabled.checked && elements.autoRetry.checked,
    deviceId: elements.deviceId.value.trim() || DEFAULT_SETTINGS.deviceId,
    enabled: elements.enabled.checked,
    intakeUrl: elements.intakeUrl.value.trim() || DEFAULT_SETTINGS.intakeUrl,
    token: elements.token.value.trim()
  });

  elements.save.textContent = "Tersimpan";
  updateModeControls();
  window.setTimeout(() => {
    elements.save.textContent = "Simpan";
  }, 900);

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

function showTestMenu() {
  elements.testMenu.hidden = false;
  elements.testMenuToggle.textContent = "Tutup Test";
  elements.testMenuToggle.setAttribute("aria-expanded", "true");
}

function hideTestMenu() {
  elements.testMenu.hidden = true;
  elements.testMenuToggle.textContent = "Test";
  elements.testMenuToggle.setAttribute("aria-expanded", "false");
}

function toggleTestMenu() {
  if (elements.testMenu.hidden) {
    showTestMenu();
    return;
  }

  hideTestMenu();
}

function showHistory() {
  elements.historyPanel.hidden = false;
  elements.openHistory.hidden = true;
}

function hideHistory() {
  elements.historyPanel.hidden = true;
  elements.openHistory.hidden = false;
}

elements.autoRetry.addEventListener("change", () => saveSettings());
elements.enabled.addEventListener("change", () => saveSettings());
elements.save.addEventListener("click", () => saveSettings());
elements.closeHistory.addEventListener("click", hideHistory);
elements.openHistory.addEventListener("click", showHistory);

elements.testIntake.addEventListener("click", () => {
  hideHistory();
  hideTestMenu();
  runPopupTest(
    elements.testIntake.querySelector("span"),
    "DELIVEREE_TEST_INTAKE",
    "Testing...",
    "Test Intake"
  );
});

elements.testDiscord.addEventListener("click", () => {
  hideHistory();
  hideTestMenu();
  runPopupTest(
    elements.testDiscord.querySelector("span"),
    "DELIVEREE_TEST_DISCORD",
    "Sending...",
    "Test Discord"
  );
});

elements.testModalSuccess.addEventListener("click", () => {
  hideHistory();
  hideTestMenu();
  runPopupTest(
    elements.testModalSuccess.querySelector("span"),
    "DELIVEREE_SIMULATE_MODAL_SUCCESS",
    "Simulating...",
    "Simulasi: Driver Ditemukan"
  );
});

elements.testModalFail.addEventListener("click", () => {
  hideHistory();
  hideTestMenu();
  runPopupTest(
    elements.testModalFail.querySelector("span"),
    "DELIVEREE_SIMULATE_MODAL_FAIL",
    "Simulating...",
    "Simulasi: Gagal Lagi"
  );
});

elements.testMenuToggle.addEventListener("click", toggleTestMenu);

render();
