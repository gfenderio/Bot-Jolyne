const DEFAULT_SETTINGS = {
  baseUrl: "https://kyou.id/items/",
  enabled: true,
  minDigits: 5,
  resetAfterMs: 700
};

const elements = {
  baseUrl: document.querySelector("#base-url"),
  enabled: document.querySelector("#enabled"),
  lastScan: document.querySelector("#last-scan"),
  minDigits: document.querySelector("#min-digits"),
  resetAfterMs: document.querySelector("#reset-after-ms"),
  save: document.querySelector("#save"),
  test: document.querySelector("#test")
};

function normalizeBaseUrl(value) {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("id-ID", {
    dateStyle: "short",
    timeStyle: "medium"
  });
}

function load() {
  chrome.storage.local.get({
    ...DEFAULT_SETTINGS,
    lastScan: undefined
  }, (stored) => {
    elements.enabled.checked = Boolean(stored.enabled);
    elements.baseUrl.value = stored.baseUrl || DEFAULT_SETTINGS.baseUrl;
    elements.minDigits.value = String(stored.minDigits || DEFAULT_SETTINGS.minDigits);
    elements.resetAfterMs.value = String(stored.resetAfterMs || DEFAULT_SETTINGS.resetAfterMs);

    if (stored.lastScan) {
      elements.lastScan.textContent = `${stored.lastScan.code} → ${stored.lastScan.url} (${formatTime(stored.lastScan.at)})`;
    }
  });
}

function save() {
  chrome.storage.local.set({
    baseUrl: normalizeBaseUrl(elements.baseUrl.value || DEFAULT_SETTINGS.baseUrl),
    enabled: elements.enabled.checked,
    minDigits: Number(elements.minDigits.value || DEFAULT_SETTINGS.minDigits),
    resetAfterMs: Number(elements.resetAfterMs.value || DEFAULT_SETTINGS.resetAfterMs)
  }, () => {
    elements.save.textContent = "Saved";
    window.setTimeout(() => {
      elements.save.textContent = "Save";
    }, 900);
  });
}

function openTestItem() {
  const url = `${normalizeBaseUrl(elements.baseUrl.value || DEFAULT_SETTINGS.baseUrl)}219402`;
  chrome.tabs.update({
    url
  });
}

elements.save.addEventListener("click", save);
elements.test.addEventListener("click", openTestItem);

load();
