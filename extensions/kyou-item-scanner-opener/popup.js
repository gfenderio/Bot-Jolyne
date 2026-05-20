const DEFAULT_SETTINGS = {
  copyKyouIdToClipboard: false,
  enabled: true,
  minDigits: 5,
  resetAfterMs: 700
};

const TEST_ITEM_URL = "https://kyou.id/items/123343/";
const TEST_ITEM_ID = "123343";
const TEST_JAN_SEARCH_URL = "https://kyou.id/search?q=4571623516248&page=1%2C40&sort=newest";
const SCAN_HISTORY_LIMIT = 5;

function getChromeStorageLocal() {
  return globalThis.chrome?.storage?.local;
}

function getChromeTabs() {
  return globalThis.chrome?.tabs;
}

function getFallbackStorageValue(keys) {
  if (typeof keys === "string") {
    return {
      [keys]: undefined
    };
  }

  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [
      key,
      undefined
    ]));
  }

  return {
    ...keys
  };
}

function storageGet(keys, callback) {
  const storage = getChromeStorageLocal();

  if (!storage) {
    callback(getFallbackStorageValue(keys));
    return;
  }

  try {
    storage.get(keys, callback);
  } catch {
    callback(getFallbackStorageValue(keys));
  }
}

function storageSet(value, callback) {
  const storage = getChromeStorageLocal();

  if (!storage) {
    callback?.();
    return;
  }

  try {
    storage.set(value, callback);
  } catch {
    callback?.();
  }
}

const elements = {
  copyCard: document.querySelector("#copy-card"),
  copyKyouId: document.querySelector("#copy-kyou-id"),
  closeHistory: document.querySelector("#close-history"),
  enabled: document.querySelector("#enabled"),
  historyPanel: document.querySelector("#history-panel"),
  minDigits: document.querySelector("#min-digits"),
  modeBadge: document.querySelector("#mode-badge"),
  resetAfterMs: document.querySelector("#reset-after-ms"),
  save: document.querySelector("#save"),
  scanHistory: document.querySelector("#scan-history"),
  testItem: document.querySelector("#test-item"),
  testJanCopy: document.querySelector("#test-jan-copy"),
  testJanOpen: document.querySelector("#test-jan-open"),
  testMenu: document.querySelector("#test-menu"),
  testMenuToggle: document.querySelector("#test-menu-toggle")
};

function formatTime(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("id-ID", {
    dateStyle: "short",
    timeStyle: "medium"
  });
}

function formatStatus(status) {
  const labels = {
    copied_and_opened: "ID disalin",
    copy_failed_opened: "Item dibuka, salin gagal",
    not_found: "Tidak ditemukan",
    opened: "Item dibuka",
    searching: "Mencari item"
  };

  return labels[status] || status || "-";
}

function getStatusClass(status) {
  if (status === "not_found" || status === "copy_failed_opened") {
    return "is-error";
  }

  if (status === "searching") {
    return "is-searching";
  }

  return "is-success";
}

function updateModeControls() {
  const enabled = elements.enabled.checked;

  if (!enabled) {
    elements.copyKyouId.checked = false;
  }

  elements.copyKyouId.disabled = !enabled;
  elements.copyCard.classList.toggle("toggle-card--disabled", !enabled);
  elements.testItem.disabled = !enabled;
  elements.testJanOpen.disabled = !enabled;
  elements.testJanCopy.disabled = !enabled;
  elements.testMenuToggle.disabled = !enabled;

  if (!enabled) {
    hideTestMenu();
  }

  elements.modeBadge.classList.remove(
    "mode-badge--copy",
    "mode-badge--inactive",
    "mode-badge--open"
  );

  if (!enabled) {
    elements.modeBadge.textContent = "Nonaktif";
    elements.modeBadge.classList.add("mode-badge--inactive");
    return;
  }

  if (elements.copyKyouId.checked) {
    elements.modeBadge.textContent = "Scan + Salin ID";
    elements.modeBadge.classList.add("mode-badge--copy");
    return;
  }

  elements.modeBadge.textContent = "Siap Scan";
  elements.modeBadge.classList.add("mode-badge--open");
}

function renderScanHistory(scanHistory) {
  const items = Array.isArray(scanHistory) ? scanHistory : [];
  elements.scanHistory.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "scan-history__empty";
    empty.textContent = "Belum ada riwayat.";
    elements.scanHistory.appendChild(empty);
    return;
  }

  for (const scan of items.slice(0, 5)) {
    const item = document.createElement("li");
    item.className = `scan-history__item ${getStatusClass(scan.status)}`;

    const title = document.createElement("strong");
    title.textContent = scan.itemId
      ? `${scan.code} -> ${scan.itemId}`
      : scan.code || "-";

    const meta = document.createElement("span");
    meta.textContent = `${formatStatus(scan.status)} | ${scan.mode || "-"} | ${formatTime(scan.at)}`;

    item.append(title, meta);
    elements.scanHistory.appendChild(item);
  }
}

function load() {
  storageGet({
    ...DEFAULT_SETTINGS,
    scanHistory: []
  }, (stored) => {
    elements.enabled.checked = Boolean(stored.enabled);
    elements.copyKyouId.checked = elements.enabled.checked && Boolean(stored.copyKyouIdToClipboard);
    elements.minDigits.value = String(stored.minDigits || DEFAULT_SETTINGS.minDigits);
    elements.resetAfterMs.value = String(stored.resetAfterMs || DEFAULT_SETTINGS.resetAfterMs);
    updateModeControls();
    renderScanHistory(stored.scanHistory);
  });
}

function save(callback) {
  updateModeControls();

  storageSet({
    copyKyouIdToClipboard: elements.enabled.checked && elements.copyKyouId.checked,
    enabled: elements.enabled.checked,
    minDigits: Number(elements.minDigits.value || DEFAULT_SETTINGS.minDigits),
    resetAfterMs: Number(elements.resetAfterMs.value || DEFAULT_SETTINGS.resetAfterMs)
  }, () => {
    elements.save.textContent = "Tersimpan";
    updateModeControls();
    window.setTimeout(() => {
      elements.save.textContent = "Simpan";
    }, 900);
    callback?.();
  });
}

function openUrl(url) {
  const tabs = getChromeTabs();

  if (!tabs) {
    window.location.href = url;
    return;
  }

  tabs.update({
    url
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function queueTestScan(scan, callback) {
  const scanWithTime = {
    at: new Date().toISOString(),
    ...scan
  };

  storageGet({
    scanHistory: []
  }, (stored) => {
    const scanHistory = Array.isArray(stored.scanHistory) ? stored.scanHistory : [];
    storageSet({
      lastScan: scanWithTime,
      pendingToast: {
        ...scanWithTime,
        queuedAt: new Date().toISOString()
      },
      scanHistory: [
        scanWithTime,
        ...scanHistory
      ].slice(0, SCAN_HISTORY_LIMIT)
    }, callback);
  });
}

async function openTestItem() {
  const copied = elements.enabled.checked && elements.copyKyouId.checked
    ? await copyText(TEST_ITEM_ID)
    : false;

  queueTestScan({
    code: TEST_ITEM_ID,
    itemId: TEST_ITEM_ID,
    mode: elements.copyKyouId.checked ? "item_copy" : "item_direct",
    result: copied ? TEST_ITEM_ID : TEST_ITEM_URL,
    status: elements.copyKyouId.checked
      ? copied ? "copied_and_opened" : "copy_failed_opened"
      : "opened",
    url: TEST_ITEM_URL
  }, () => {
    openUrl(TEST_ITEM_URL);
  });
}

function openTestJanOpen() {
  elements.copyKyouId.checked = false;
  save(() => openUrl(TEST_JAN_SEARCH_URL));
}

function openTestJanCopy() {
  elements.copyKyouId.checked = true;
  save(() => openUrl(TEST_JAN_SEARCH_URL));
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function showHistory() {
  elements.historyPanel.hidden = false;
}

function hideHistory() {
  elements.historyPanel.hidden = true;
}

elements.copyKyouId.addEventListener("change", () => save());
elements.enabled.addEventListener("change", () => save());
elements.save.addEventListener("click", () => save());
elements.closeHistory.addEventListener("click", hideHistory);
elements.testItem.addEventListener("click", () => {
  hideHistory();
  hideTestMenu();
  openTestItem();
});
elements.testJanOpen.addEventListener("click", () => {
  hideHistory();
  hideTestMenu();
  openTestJanOpen();
});
elements.testJanCopy.addEventListener("click", () => {
  hideHistory();
  hideTestMenu();
  openTestJanCopy();
});
elements.testMenuToggle.addEventListener("click", toggleTestMenu);

load();
