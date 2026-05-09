const DEFAULT_SETTINGS = {
  deviceId: "yugi-browser",
  intakeUrl: "http://127.0.0.1:3001",
  token: ""
};
const MAX_LOG_ENTRIES = 120;

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
    await appendLog(response.ok ? "info" : "error", labels.finishedEvent, labels.finishedMessage, {
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

function testLocalIntake() {
  return sendControlRequest("/deliveree/extension/health", {
    failedEvent: "test_intake_failed",
    failedMessage: "Gagal menghubungi local intake Jolyne.",
    finishedEvent: "test_intake_finished",
    finishedMessage: "Local intake Jolyne merespons test koneksi.",
    skippedEvent: "test_intake_skipped",
    startedEvent: "test_intake_started",
    startedMessage: "Menguji koneksi local intake Jolyne."
  });
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

  if (message?.type !== "DELIVEREE_STATUS") {
    return false;
  }

  sendStatus(message.payload).then(sendResponse);
  return true;
});
