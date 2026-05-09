const DEFAULT_SETTINGS = {
  deviceId: "yugi-browser",
  intakeUrl: "http://127.0.0.1:3001",
  token: ""
};
const MAX_LOG_ENTRIES = 120;
let lastPageStateSuccessLogFingerprint = "";

function normalizeBaseUrl(value) {
  return (value || DEFAULT_SETTINGS.intakeUrl).replace(/\/+$/, "");
}

function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

async function appendLog(level, event, message, details = {}) {
  const data = await chrome.storage.local.get({
    extensionLogs: []
  });
  const logs = Array.isArray(data.extensionLogs) ? data.extensionLogs : [];
  const entry = {
    at: new Date().toISOString(),
    details,
    event,
    level,
    message
  };

  await chrome.storage.local.set({
    extensionLogs: [entry, ...logs].slice(0, MAX_LOG_ENTRIES)
  });
}

function saveLastResult(result) {
  return chrome.storage.local.set({
    lastResult: {
      ...result,
      at: new Date().toISOString()
    }
  });
}

function fingerprintPageStateLog(pageState) {
  return [
    pageState.pageKind || "",
    pageState.bookingId || "",
    pageState.status || "",
    pageState.eventType || "",
    pageState.pageUrl || ""
  ].join("|");
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({
      active: true,
      currentWindow: true
    }, (tabs) => {
      resolve(tabs?.[0]);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const lastError = chrome.runtime.lastError;

      if (lastError) {
        resolve({
          error: lastError.message,
          ok: false
        });
        return;
      }

      resolve(response || {
        error: "empty_response",
        ok: false
      });
    });
  });
}

async function sendStatus(payload) {
  const settings = await getSettings();
  const payloadSummary = {
    bookingId: payload.bookingId,
    destinationCount: payload.destinationCount,
    duplicateUrlDetected: Boolean(payload.duplicateUrl),
    eventType: payload.eventType,
    failureReason: payload.failureReason,
    jobNo: payload.jobNo,
    serviceType: payload.serviceType,
    status: payload.status,
    totalDistanceKm: payload.totalDistanceKm
  };

  await chrome.storage.local.set({
    lastEvent: {
      bookingId: payload.bookingId,
      eventType: payload.eventType,
      observedAt: payload.observedAt,
      pageUrl: payload.pageUrl,
      status: payload.status
    }
  });
  await appendLog(
    "info",
    "mvp_signal_detected",
    `Detected Deliveree ${payload.eventType} for #${payload.bookingId}.`,
    payloadSummary
  );

  if (!settings.token) {
    const result = {
      error: "token_not_configured",
      ok: false
    };
    await saveLastResult(result);
    await appendLog("error", "send_skipped", "Token extension belum diisi di popup.", {
      bookingId: payload.bookingId,
      eventType: payload.eventType,
      status: payload.status
    });
    return result;
  }

  try {
    await appendLog("info", "send_started", "Mengirim status ke local intake Jolyne.", {
      bookingId: payload.bookingId,
      eventType: payload.eventType,
      intakeUrl: normalizeBaseUrl(settings.intakeUrl),
      status: payload.status
    });
    const response = await fetch(`${normalizeBaseUrl(settings.intakeUrl)}/deliveree/extension/status`, {
      body: JSON.stringify(payload),
      headers: {
        "Authorization": `Bearer ${settings.token}`,
        "Content-Type": "application/json",
        "X-Deliveree-Device-Id": settings.deviceId
      },
      method: "POST"
    });
    const body = await response.json().catch(() => ({
      error: "invalid_response",
      ok: false
    }));
    const result = {
      ...body,
      httpStatus: response.status
    };

    await saveLastResult(result);
    await appendLog(response.ok ? "info" : "error", "send_finished", "Local intake Jolyne merespons event.", {
      action: result.action,
      bookingId: payload.bookingId,
      deduped: result.deduped,
      eventType: payload.eventType,
      error: result.error,
      httpStatus: response.status,
      ok: result.ok,
      status: payload.status
    });
    return result;
  } catch (error) {
    const result = {
      error: error instanceof Error ? error.message : "network_error",
      ok: false
    };
    await saveLastResult(result);
    await appendLog("error", "send_failed", "Gagal menghubungi local intake Jolyne.", {
      bookingId: payload.bookingId,
      eventType: payload.eventType,
      error: result.error,
      intakeUrl: normalizeBaseUrl(settings.intakeUrl),
      status: payload.status
    });
    return result;
  }
}

async function sendPageState(pageState, options = {}) {
  const settings = await getSettings();

  if (!settings.token) {
    await appendLog("error", "page_state_skipped", "Token extension belum diisi di popup.", {
      pageKind: pageState.pageKind,
      status: pageState.status
    });
    return {
      error: "token_not_configured",
      ok: false
    };
  }

  try {
    const response = await fetch(`${normalizeBaseUrl(settings.intakeUrl)}/deliveree/extension/page-state`, {
      body: JSON.stringify(pageState),
      headers: {
        "Authorization": `Bearer ${settings.token}`,
        "Content-Type": "application/json",
        "X-Deliveree-Device-Id": settings.deviceId
      },
      method: "POST"
    });
    const body = await response.json().catch(() => ({
      error: "invalid_response",
      ok: false
    }));
    const result = {
      ...body,
      httpStatus: response.status
    };

    if (!response.ok) {
      await appendLog("error", "page_state_failed", "Jolyne gagal menerima page state.", {
        error: body.error,
        httpStatus: response.status,
        pageKind: pageState.pageKind,
        status: pageState.status
      });
    }

    if (response.ok) {
      const fingerprint = fingerprintPageStateLog(pageState);

      if (options.forceLog || fingerprint !== lastPageStateSuccessLogFingerprint) {
        lastPageStateSuccessLogFingerprint = fingerprint;
        await appendLog("info", "page_state_finished", "Extension membaca halaman Deliveree.", {
          action: result.action,
          bookingId: pageState.bookingId,
          eventType: pageState.eventType,
          httpStatus: response.status,
          ok: result.ok,
          pageKind: pageState.pageKind,
          status: pageState.status,
          statusText: pageState.statusText
        });
      }
    }

    return result;
  } catch (error) {
    await appendLog("error", "page_state_network_failed", "Gagal mengirim page state ke Jolyne.", {
      error: error instanceof Error ? error.message : "network_error",
      pageKind: pageState.pageKind,
      status: pageState.status
    });
    return {
      error: error instanceof Error ? error.message : "network_error",
      ok: false
    };
  }
}

async function testActiveDelivereePageStatus() {
  const tab = await getActiveTab();
  const tabUrl = tab?.url || "";

  if (!tab?.id) {
    await appendLog("error", "active_page_status_failed", "Tab aktif tidak bisa dibaca oleh extension.", {});
    return {
      error: "active_tab_unavailable",
      ok: false
    };
  }

  if (!tabUrl.startsWith("https://webapp.deliveree.com/")) {
    await appendLog("warning", "active_page_not_deliveree", "Tab aktif bukan halaman Deliveree.", {
      tabUrl
    });
    return {
      error: "active_tab_not_deliveree",
      ok: false
    };
  }

  await appendLog("info", "active_page_status_started", "Membaca status halaman Deliveree aktif.", {
    tabUrl
  });

  const collected = await sendMessageToTab(tab.id, {
    type: "DELIVEREE_COLLECT_PAGE_STATE"
  });

  if (!collected?.ok || !collected.pageState) {
    await appendLog("error", "active_page_status_failed", "Content script belum bisa membaca halaman Deliveree aktif.", {
      error: collected?.error || "unknown_error",
      tabUrl
    });
    return {
      error: collected?.error || "page_state_unavailable",
      ok: false
    };
  }

  const result = await sendPageState(collected.pageState, {
    forceLog: true
  });

  await appendLog(result.ok ? "info" : "error", "active_page_status_finished", "Test Intake membaca status halaman aktif.", {
    bookingId: collected.pageState.bookingId,
    error: result.error,
    httpStatus: result.httpStatus,
    ok: result.ok,
    pageKind: collected.pageState.pageKind,
    source: collected.source,
    status: collected.pageState.status,
    statusText: collected.pageState.statusText
  });

  return result;
}

async function sendControlRequest(endpoint, labels) {
  const settings = await getSettings();

  if (!settings.token) {
    const result = {
      error: "token_not_configured",
      ok: false
    };
    await saveLastResult(result);
    await appendLog("error", labels.skippedEvent, "Token extension belum diisi di popup.", {
      deviceId: settings.deviceId
    });
    return result;
  }

  try {
    await appendLog("info", labels.startedEvent, labels.startedMessage, {
      deviceId: settings.deviceId,
      intakeUrl: normalizeBaseUrl(settings.intakeUrl)
    });
    const response = await fetch(`${normalizeBaseUrl(settings.intakeUrl)}${endpoint}`, {
      headers: {
        "Authorization": `Bearer ${settings.token}`,
        "X-Deliveree-Device-Id": settings.deviceId
      },
      method: "POST"
    });
    const body = await response.json().catch(() => ({
      error: "invalid_response",
      ok: false
    }));
    const result = {
      ...body,
      httpStatus: response.status
    };

    await saveLastResult(result);
    await appendLog(response.ok ? "info" : "error", labels.finishedEvent, response.ok ? labels.finishedMessage : body.error || labels.failedMessage, {
      action: result.action,
      deviceId: settings.deviceId,
      error: result.error,
      httpStatus: response.status,
      ok: result.ok
    });
    return result;
  } catch (error) {
    const result = {
      error: error instanceof Error ? error.message : "network_error",
      ok: false
    };
    await saveLastResult(result);
    await appendLog("error", labels.failedEvent, labels.failedMessage, {
      deviceId: settings.deviceId,
      error: result.error,
      intakeUrl: normalizeBaseUrl(settings.intakeUrl)
    });
    return result;
  }
}

async function testLocalIntake() {
  const result = await sendControlRequest("/deliveree/extension/health", {
    failedEvent: "test_intake_failed",
    failedMessage: "Gagal menghubungi local intake Jolyne.",
    finishedEvent: "test_intake_finished",
    finishedMessage: "Local intake Jolyne merespons test koneksi.",
    skippedEvent: "test_intake_skipped",
    startedEvent: "test_intake_started",
    startedMessage: "Menguji koneksi local intake Jolyne."
  });

  if (result.ok) {
    await testActiveDelivereePageStatus();
  }

  return result;
}

function sendDiscordTest() {
  return sendControlRequest("/deliveree/extension/test-discord", {
    failedEvent: "discord_test_failed",
    failedMessage: "Gagal mengirim test Discord lewat Jolyne.",
    finishedEvent: "discord_test_finished",
    finishedMessage: "Jolyne merespons permintaan test Discord.",
    skippedEvent: "discord_test_skipped",
    startedEvent: "discord_test_started",
    startedMessage: "Meminta Jolyne mengirim test Discord."
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DELIVEREE_LOG") {
    appendLog(
      message.level || "info",
      message.event || "content_log",
      message.message || "Content script log.",
      message.details || {}
    ).then(() => sendResponse({
      ok: true
    }));
    return true;
  }

  if (message?.type === "DELIVEREE_TEST_INTAKE") {
    testLocalIntake().then(sendResponse);
    return true;
  }

  if (message?.type === "DELIVEREE_TEST_DISCORD") {
    sendDiscordTest().then(sendResponse);
    return true;
  }

  if (message?.type === "DELIVEREE_PAGE_STATE") {
    sendPageState(message.pageState).then(sendResponse);
    return true;
  }

  if (message?.type !== "DELIVEREE_STATUS") {
    return false;
  }

  sendStatus(message.payload).then(sendResponse);
  return true;
});
