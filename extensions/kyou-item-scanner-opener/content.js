const DEFAULT_SETTINGS = {
  baseUrl: "https://kyou.id/items/",
  enabled: true,
  minDigits: 5,
  resetAfterMs: 700
};

let settings = {
  ...DEFAULT_SETTINGS
};
let buffer = "";
let resetTimer;

function normalizeSettings(value) {
  return {
    baseUrl: typeof value?.baseUrl === "string" && value.baseUrl.trim()
      ? value.baseUrl.trim()
      : DEFAULT_SETTINGS.baseUrl,
    enabled: typeof value?.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
    minDigits: Number.isInteger(value?.minDigits) && value.minDigits > 0
      ? value.minDigits
      : DEFAULT_SETTINGS.minDigits,
    resetAfterMs: Number.isInteger(value?.resetAfterMs) && value.resetAfterMs >= 100
      ? value.resetAfterMs
      : DEFAULT_SETTINGS.resetAfterMs
  };
}

function loadSettings() {
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    settings = normalizeSettings(stored);
  });
}

function isEditableTarget(target) {
  if (!target) {
    return false;
  }

  const tagName = target.tagName?.toLowerCase();

  return Boolean(
    target.isContentEditable
    || tagName === "input"
    || tagName === "textarea"
    || tagName === "select"
  );
}

function resetBuffer() {
  buffer = "";
  window.clearTimeout(resetTimer);
}

function scheduleReset() {
  window.clearTimeout(resetTimer);
  resetTimer = window.setTimeout(resetBuffer, settings.resetAfterMs);
}

function buildItemUrl(code) {
  const baseUrl = settings.baseUrl.endsWith("/") ? settings.baseUrl : `${settings.baseUrl}/`;
  return `${baseUrl}${encodeURIComponent(code)}`;
}

function recordLastScan(code, url) {
  chrome.storage.local.set({
    lastScan: {
      at: new Date().toISOString(),
      code,
      url
    }
  });
}

function openItem(code) {
  const url = buildItemUrl(code);
  recordLastScan(code, url);
  window.location.assign(url);
}

function maybeSubmitBuffer() {
  const code = buffer.trim();
  resetBuffer();

  if (!new RegExp(`^\\d{${settings.minDigits},}$`).test(code)) {
    return;
  }

  openItem(code);
}

function handleKeydown(event) {
  if (!settings.enabled || event.ctrlKey || event.altKey || event.metaKey || isEditableTarget(event.target)) {
    return;
  }

  if (event.key === "Enter") {
    maybeSubmitBuffer();
    return;
  }

  if (/^\d$/.test(event.key)) {
    buffer += event.key;
    scheduleReset();
    return;
  }

  resetBuffer();
}

loadSettings();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  settings = normalizeSettings({
    ...settings,
    baseUrl: changes.baseUrl?.newValue,
    enabled: changes.enabled?.newValue,
    minDigits: changes.minDigits?.newValue,
    resetAfterMs: changes.resetAfterMs?.newValue
  });
});

window.addEventListener("keydown", handleKeydown, true);
