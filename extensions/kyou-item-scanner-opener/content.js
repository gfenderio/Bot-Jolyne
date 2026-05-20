const KYOU_ORIGIN = "https://kyou.id";
const KYOU_ITEM_MAX_DIGITS = 6;
const SEARCH_MIN_DIGITS = KYOU_ITEM_MAX_DIGITS + 1;
const SCAN_HISTORY_LIMIT = 5;
const TOAST_RENDER_DELAY_MS = 450;
const SEARCH_RESULT_TIMEOUT_MS = 12000;
const TOAST_DURATION_MS = 3600;
const TOAST_STORAGE_KEY = "pendingToast";
const TOAST_SESSION_KEY = "kyouScannerPartnerPendingToast";

const DEFAULT_SETTINGS = {
  copyKyouIdToClipboard: false,
  enabled: true,
  minDigits: 5,
  resetAfterMs: 700
};

let settings = {
  ...DEFAULT_SETTINGS
};
let buffer = "";
let resetTimer;
let searchResultObserver;
let searchResultHandled = false;
let toastWatchTimer;
let lastToastWatchHref = window.location.href;
let lastConsumedToastKey = "";

function isContextInvalidated() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
      return true;
    }
    chrome.runtime.getURL("");
    return false;
  } catch {
    return true;
  }
}

function checkContextAndCleanup() {
  if (isContextInvalidated()) {
    if (toastWatchTimer) {
      window.clearInterval(toastWatchTimer);
      toastWatchTimer = null;
    }
    if (resetTimer) {
      window.clearTimeout(resetTimer);
      resetTimer = null;
    }
    if (searchResultObserver) {
      searchResultObserver.disconnect();
      searchResultObserver = null;
    }
    window.removeEventListener("keydown", handleKeydown, true);
    return true;
  }
  return false;
}

function getChromeStorageLocal() {
  if (isContextInvalidated()) return undefined;
  try {
    return globalThis.chrome?.storage?.local;
  } catch {
    return undefined;
  }
}

function getChromeStorageChanges() {
  if (isContextInvalidated()) return undefined;
  try {
    return globalThis.chrome?.storage?.onChanged;
  } catch {
    return undefined;
  }
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

function storageRemove(keys, callback) {
  const storage = getChromeStorageLocal();

  if (!storage) {
    callback?.();
    return;
  }

  try {
    storage.remove(keys, callback);
  } catch {
    callback?.();
  }
}

function normalizeSettings(value) {
  return {
    copyKyouIdToClipboard: typeof value?.copyKyouIdToClipboard === "boolean"
      ? value.copyKyouIdToClipboard
      : DEFAULT_SETTINGS.copyKyouIdToClipboard,
    enabled: typeof value?.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.enabled,
    minDigits: Number.isInteger(value?.minDigits) && value.minDigits > 0
      ? value.minDigits
      : DEFAULT_SETTINGS.minDigits,
    resetAfterMs: Number.isInteger(value?.resetAfterMs) && value.resetAfterMs >= 100
      ? value.resetAfterMs
      : DEFAULT_SETTINGS.resetAfterMs
  };
}

function loadSettings(callback) {
  storageGet(DEFAULT_SETTINGS, (stored) => {
    settings = normalizeSettings(stored);
    callback?.();
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
  return `${KYOU_ORIGIN}/items/${encodeURIComponent(code)}/`;
}

function buildSearchUrl(code) {
  return `${KYOU_ORIGIN}/search?q=${encodeURIComponent(code)}&page=1%2C40&sort=newest`;
}

function getScanDestination(code) {
  return code.length > KYOU_ITEM_MAX_DIGITS ? "search" : "item";
}

function getToastMessage(scan) {
  if (!scan || typeof scan !== "object") {
    return "Scanner Partner siap";
  }

  if (scan.status === "not_found") {
    return `Kode tidak ditemukan: ${scan.code || "-"}`;
  }

  if (scan.status === "copy_failed_opened") {
    return `Copy gagal, item dibuka: ${scan.itemId || scan.code}`;
  }

  if (scan.status === "copied_and_opened") {
    return `Kyou ID ${scan.itemId || scan.result} disalin, item dibuka`;
  }

  if (scan.status === "searching") {
    return `Mencari kode: ${scan.code || "-"}`;
  }

  if (scan.status === "opened") {
    return `Item ${scan.itemId || scan.code} dibuka`;
  }

  return `Scanner Partner: ${scan.status || "done"}`;
}

function readSessionPendingToast() {
  if (typeof sessionStorage === "undefined") {
    return undefined;
  }

  let rawToast;

  try {
    rawToast = sessionStorage.getItem(TOAST_SESSION_KEY);
  } catch {
    return undefined;
  }

  if (!rawToast) {
    return undefined;
  }

  try {
    return JSON.parse(rawToast);
  } catch {
    clearSessionPendingToast();
    return undefined;
  }
}

function writeSessionPendingToast(pendingToast) {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.setItem(TOAST_SESSION_KEY, JSON.stringify(pendingToast));
  } catch {
    return;
  }
}

function clearSessionPendingToast() {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.removeItem(TOAST_SESSION_KEY);
  } catch {
    return;
  }
}

function showScanToast(scan) {
  const existing = document.querySelector("#kyou-scanner-partner-toast");
  existing?.remove();

  const toastRoot = document.documentElement || document.body;

  if (!toastRoot) {
    window.setTimeout(() => showScanToast(scan), 200);
    return;
  }

  const toast = document.createElement("div");
  toast.id = "kyou-scanner-partner-toast";
  toast.textContent = getToastMessage(scan);
  toast.style.background = scan.status === "not_found"
    ? "linear-gradient(135deg, #4b5563, #22272f)"
    : "linear-gradient(135deg, #fc4c02, #ff7a3c)";
  toast.style.border = "1px solid rgba(255, 255, 255, 0.35)";
  toast.style.borderRadius = "999px";
  toast.style.boxShadow = "0 14px 32px rgba(0, 0, 0, 0.24)";
  toast.style.boxSizing = "border-box";
  toast.style.color = "#fff";
  toast.style.fontFamily = "\"Nunito\", \"M PLUS Rounded 1c\", \"Segoe UI\", system-ui, sans-serif";
  toast.style.fontSize = "13px";
  toast.style.fontWeight = "700";
  toast.style.left = "50%";
  toast.style.maxWidth = "calc(100vw - 32px)";
  toast.style.opacity = "0";
  toast.style.padding = "10px 16px";
  toast.style.pointerEvents = "none";
  toast.style.position = "fixed";
  toast.style.textAlign = "center";
  toast.style.top = "76px";
  toast.style.transform = "translateX(-50%) translateY(-8px)";
  toast.style.transition = "opacity 160ms ease, transform 160ms ease";
  toast.style.zIndex = "2147483647";

  toastRoot.appendChild(toast);

  window.requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateX(-50%) translateY(0)";
  });

  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-50%) translateY(-8px)";
    window.setTimeout(() => toast.remove(), 180);
  }, TOAST_DURATION_MS);
}

function getItemIdFromPathname(pathname) {
  return pathname.match(/^\/items\/(\d+)(?:\/|$)/)?.[1] || "";
}

function isValidPendingToast(pendingToast) {
  if (!pendingToast || typeof pendingToast !== "object") {
    return false;
  }

  return Boolean(
    typeof pendingToast.status === "string"
    && (
      typeof pendingToast.code === "string"
      || typeof pendingToast.itemId === "string"
      || typeof pendingToast.result === "string"
    )
  );
}

function isPendingToastTargetPage(pendingToast, currentHref) {
  if (!isValidPendingToast(pendingToast)) {
    return false;
  }

  const targetUrl = pendingToast.url ? new URL(pendingToast.url, window.location.origin) : undefined;
  const currentUrl = new URL(currentHref);

  if (!targetUrl) {
    return true;
  }

  if (pendingToast.status === "not_found" && currentUrl.pathname === "/search") {
    return true;
  }

  if (currentUrl.origin !== targetUrl.origin) {
    return false;
  }

  if (currentUrl.pathname === targetUrl.pathname) {
    return true;
  }

  const expectedItemId = pendingToast.itemId || getItemIdFromPathname(targetUrl.pathname);
  return Boolean(expectedItemId && getItemIdFromPathname(currentUrl.pathname) === expectedItemId);
}

function consumePendingToast(pendingToast) {
  if (!isValidPendingToast(pendingToast)) {
    clearSessionPendingToast();
    storageRemove(TOAST_STORAGE_KEY);
    return;
  }

  const toastKey = [
    pendingToast.queuedAt,
    pendingToast.status,
    pendingToast.code,
    pendingToast.itemId,
    pendingToast.url
  ].join("|");

  if (toastKey === lastConsumedToastKey) {
    return;
  }

  lastConsumedToastKey = toastKey;
  clearSessionPendingToast();
  storageRemove(TOAST_STORAGE_KEY);
  window.setTimeout(() => showScanToast(pendingToast), TOAST_RENDER_DELAY_MS);
}

function showPendingToastIfAny() {
  const sessionPendingToast = readSessionPendingToast();

  if (sessionPendingToast && !isValidPendingToast(sessionPendingToast)) {
    clearSessionPendingToast();
  }

  if (sessionPendingToast && isPendingToastTargetPage(sessionPendingToast, window.location.href)) {
    consumePendingToast(sessionPendingToast);
    return;
  }

  storageGet(TOAST_STORAGE_KEY, (stored) => {
    const storagePendingToast = stored?.[TOAST_STORAGE_KEY];

    if (!storagePendingToast) {
      return;
    }

    if (!isValidPendingToast(storagePendingToast)) {
      storageRemove(TOAST_STORAGE_KEY);
      return;
    }

    if (!isPendingToastTargetPage(storagePendingToast, window.location.href)) {
      return;
    }

    consumePendingToast(storagePendingToast);
  });
}

function armPendingToastWatcher() {
  const retryDelays = [
    0,
    300,
    800,
    1500,
    3000,
    5000
  ];

  for (const delay of retryDelays) {
    window.setTimeout(showPendingToastIfAny, delay);
  }

  window.clearInterval(toastWatchTimer);
  toastWatchTimer = window.setInterval(() => {
    if (checkContextAndCleanup()) return;
    if (window.location.href === lastToastWatchHref) {
      return;
    }

    lastToastWatchHref = window.location.href;
    showPendingToastIfAny();
  }, 400);
}

function recordLastScan({
  code,
  itemId = "",
  mode,
  result = "",
  status,
  url = ""
}) {
  const scan = {
    at: new Date().toISOString(),
    code,
    itemId,
    mode,
    result,
    status,
    url
  };
  const pendingToast = {
    ...scan,
    queuedAt: new Date().toISOString()
  };

  writeSessionPendingToast(pendingToast);

  return new Promise((resolve) => {
    storageGet({
      scanHistory: []
    }, (stored) => {
      const scanHistory = Array.isArray(stored.scanHistory) ? stored.scanHistory : [];
      storageSet({
        lastScan: scan,
        [TOAST_STORAGE_KEY]: pendingToast,
        scanHistory: [
          scan,
          ...scanHistory
        ].slice(0, SCAN_HISTORY_LIMIT)
      }, resolve);
    });
  });
}

async function openItem(code) {
  const url = buildItemUrl(code);

  if (settings.copyKyouIdToClipboard) {
    const copied = await copyText(code);
    await recordLastScan({
      code,
      itemId: code,
      mode: "item_copy",
      result: copied ? code : url,
      status: copied ? "copied_and_opened" : "copy_failed_opened",
      url
    });
    window.location.assign(url);
    return;
  }

  await recordLastScan({
    code,
    itemId: code,
    mode: "item_direct",
    result: url,
    status: "opened",
    url
  });
  window.location.assign(url);
}

async function openSearch(code) {
  const url = buildSearchUrl(code);
  await recordLastScan({
    code,
    mode: settings.copyKyouIdToClipboard ? "code_copy_search" : "code_open_search",
    result: url,
    status: "searching",
    url
  });
  window.location.assign(url);
}

async function maybeSubmitBuffer() {
  const code = buffer.trim();
  resetBuffer();

  if (!new RegExp(`^\\d{${settings.minDigits},}$`).test(code)) {
    return;
  }

  if (getScanDestination(code) === "search") {
    await openSearch(code);
    return;
  }

  await openItem(code);
}

function handleKeydown(event) {
  if (checkContextAndCleanup()) return;
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

function getSearchQuery() {
  const url = new URL(window.location.href);

  if (url.pathname !== "/search") {
    return "";
  }

  const query = url.searchParams.get("q")?.trim() || "";
  return new RegExp(`^\\d{${SEARCH_MIN_DIGITS},}$`).test(query) ? query : "";
}

function extractKyouItemId(itemUrl) {
  const url = new URL(itemUrl, window.location.origin);
  return url.pathname.match(/^\/items\/(\d+)(?:\/|$)/)?.[1] || "";
}

function findFirstSearchResultItem() {
  const selectors = [
    ".content__main .gallery-product__content__product a[href^='/items/']",
    ".content__main a[href^='/items/']",
    ".searchpage a[href^='/items/']"
  ];

  for (const selector of selectors) {
    const link = document.querySelector(selector);

    if (link instanceof HTMLAnchorElement) {
      const url = new URL(link.getAttribute("href"), window.location.origin).href;
      const itemId = extractKyouItemId(url);

      if (itemId) {
        return {
          itemId,
          url
        };
      }
    }
  }

  return undefined;
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.left = "-9999px";
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return fallbackCopyText(text);
  }
}

async function handleSearchResultIfReady(query) {
  if (searchResultHandled) {
    return true;
  }

  const item = findFirstSearchResultItem();

  if (!item) {
    return false;
  }

  searchResultHandled = true;
  const shortItemUrl = buildItemUrl(item.itemId);

  if (settings.copyKyouIdToClipboard) {
    const copied = await copyText(item.itemId);
    await recordLastScan({
      code: query,
      itemId: item.itemId,
      mode: "code_copy",
      result: copied ? item.itemId : shortItemUrl,
      status: copied ? "copied_and_opened" : "copy_failed_opened",
      url: shortItemUrl
    });
    window.location.replace(shortItemUrl);
    return true;
  }

  await recordLastScan({
    code: query,
    itemId: item.itemId,
    mode: "code_redirect",
    result: shortItemUrl,
    status: "opened",
    url: shortItemUrl
  });
  window.location.replace(shortItemUrl);
  return true;
}

function autoHandleSearchResult() {
  const query = getSearchQuery();

  if (!query) {
    return;
  }

  handleSearchResultIfReady(query).then((handled) => {
    if (handled) {
      return;
    }

    searchResultObserver?.disconnect();
    searchResultObserver = new MutationObserver(() => {
      handleSearchResultIfReady(query).then((observerHandled) => {
        if (observerHandled) {
          searchResultObserver?.disconnect();
          searchResultObserver = undefined;
        }
      });
    });

    searchResultObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    window.setTimeout(() => {
      if (!searchResultHandled) {
        recordLastScan({
          code: query,
          mode: settings.copyKyouIdToClipboard ? "code_copy" : "code_redirect",
          result: "",
          status: "not_found",
          url: window.location.href
        }).then(() => {
          window.setTimeout(showPendingToastIfAny, 100);
        });
      }

      searchResultObserver?.disconnect();
      searchResultObserver = undefined;
    }, SEARCH_RESULT_TIMEOUT_MS);
  });
}

function getNextData() {
  const script = document.querySelector("#__NEXT_DATA__");

  if (!script?.textContent) {
    return undefined;
  }

  try {
    return JSON.parse(script.textContent);
  } catch {
    return undefined;
  }
}

function getMissingItemPageCode() {
  const currentUrl = new URL(window.location.href);
  const itemId = getItemIdFromPathname(currentUrl.pathname);

  if (!itemId) {
    return "";
  }

  const nextData = getNextData();
  const pageProps = nextData?.props?.pageProps;

  if (
    nextData?.page === "/items/[id]"
    && pageProps?.data === null
    && pageProps?.itemError
  ) {
    return itemId;
  }

  return "";
}

function recoverMissingItemPage() {
  const code = getMissingItemPageCode();

  if (!code) {
    return false;
  }

  const url = buildSearchUrl(code);

  recordLastScan({
    code,
    mode: "item_not_found",
    result: "",
    status: "not_found",
    url
  }).then(() => {
    window.location.replace(url);
  });

  return true;
}

loadSettings(() => {
  armPendingToastWatcher();
  if (recoverMissingItemPage()) {
    return;
  }

  autoHandleSearchResult();
});

getChromeStorageChanges()?.addListener((changes, areaName) => {
  if (checkContextAndCleanup()) return;
  if (areaName !== "local") {
    return;
  }

  const nextSettings = {
    ...settings,
  };

  if (Object.hasOwn(changes, "copyKyouIdToClipboard")) {
    nextSettings.copyKyouIdToClipboard = changes.copyKyouIdToClipboard.newValue;
  }

  if (Object.hasOwn(changes, "enabled")) {
    nextSettings.enabled = changes.enabled.newValue;
  }

  if (Object.hasOwn(changes, "minDigits")) {
    nextSettings.minDigits = changes.minDigits.newValue;
  }

  if (Object.hasOwn(changes, "resetAfterMs")) {
    nextSettings.resetAfterMs = changes.resetAfterMs.newValue;
  }

  settings = normalizeSettings(nextSettings);

  if (Object.hasOwn(changes, TOAST_STORAGE_KEY)) {
    window.setTimeout(showPendingToastIfAny, 100);
  }
});

window.addEventListener("keydown", handleKeydown, true);
