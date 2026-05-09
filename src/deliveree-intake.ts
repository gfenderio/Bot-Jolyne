import { env } from "./config/env.js";
import { createDelivereeExtensionIntakeServer, DelivereeExtensionDiscordTestDisabledError, type DelivereeExtensionConnectionTestNotification, type DelivereeExtensionNotification, type DelivereeExtensionNotificationSender } from "./deliveree/extensionIntake.js";
import { createDelivereeCaseStore } from "./deliveree/liveRuntime.js";

class ConsoleDelivereeExtensionNotifier implements DelivereeExtensionNotificationSender {
  async send(notification: DelivereeExtensionNotification) {
    console.log(JSON.stringify({
      action: notification.action,
      bookingId: notification.payload.bookingId,
      caseId: notification.recoveryCase.caseId,
      deviceId: notification.deviceId,
      event: "deliveree_extension_signal",
      failureReason: notification.payload.failureReason,
      observedAt: notification.payload.observedAt,
      pageUrl: notification.payload.pageUrl,
      status: notification.payload.status
    }));
  }

  async sendConnectionTest(notification: DelivereeExtensionConnectionTestNotification) {
    console.log(JSON.stringify({
      deviceId: notification.deviceId,
      event: "deliveree_extension_connection_test",
      mode: "intake_only_no_discord_send",
      observedAt: notification.observedAt
    }));
    throw new DelivereeExtensionDiscordTestDisabledError("Intake-only runner tidak mengirim Discord test. Gunakan full Jolyne runtime untuk test Discord.");
  }
}

const loggedPageStateFingerprints = new Map<string, string>();

function pageStateLogKey(state: { deviceId: string; pageUrl: string }) {
  return `${state.deviceId}|${state.pageUrl}`;
}

function pageStateLogFingerprint(state: {
  bookingId?: string;
  eventType?: string;
  pageKind: string;
  status?: string;
  statusText?: string;
}) {
  return [
    state.pageKind,
    state.bookingId || "",
    state.status || "",
    state.statusText || "",
    state.eventType || ""
  ].join("|");
}

if (!env.DELIVEREE_EXTENSION_TOKEN) {
  throw new Error("DELIVEREE_EXTENSION_TOKEN wajib diisi untuk menjalankan Deliveree intake-only server.");
}

const server = createDelivereeExtensionIntakeServer({
  allowedDeviceIds: env.DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS,
  notifier: new ConsoleDelivereeExtensionNotifier(),
  onPageState(state, context) {
    const key = pageStateLogKey(state);
    const fingerprint = pageStateLogFingerprint(state);

    if (!context.manualTest && loggedPageStateFingerprints.get(key) === fingerprint) {
      return;
    }

    loggedPageStateFingerprints.set(key, fingerprint);
    console.log(JSON.stringify({
      bookingId: state.bookingId,
      deviceId: state.deviceId,
      event: "deliveree_extension_page_state",
      eventType: state.eventType,
      manualTest: context.manualTest,
      pageKind: state.pageKind,
      pageUrl: state.pageUrl,
      receivedAt: state.receivedAt,
      status: state.status,
      statusStartedAt: state.statusStartedAt,
      statusText: state.statusText
    }));
  },
  store: createDelivereeCaseStore(),
  token: env.DELIVEREE_EXTENSION_TOKEN
});

server.listen(env.DELIVEREE_EXTENSION_PORT, "127.0.0.1", () => {
  console.log(`Deliveree intake-only aktif di http://127.0.0.1:${env.DELIVEREE_EXTENSION_PORT}.`);
  console.log(`Allowed devices: ${env.DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS.join(", ")}.`);
  console.log("Mode: local extension intake only, tanpa Discord gateway login.");
});

server.on("error", (error) => {
  console.error("Deliveree intake-only server error.", error);
});

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error("Gagal menutup Deliveree intake-only server.", error);
      process.exit(1);
    }

    console.log("Deliveree intake-only server ditutup.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
