import { env } from "./config/env.js";
import {
  createDelivereeExtensionIntakeServer,
  DelivereeExtensionDiscordTestDisabledError,
  DiscordRestDelivereeExtensionNotifier,
  type DelivereeExtensionConnectionTestNotification,
  type DelivereeExtensionNotification,
  type DelivereeExtensionNotificationSender
} from "./deliveree/extensionIntake.js";
import { createDelivereeCaseStore } from "./deliveree/liveRuntime.js";

class ConsoleDelivereeExtensionNotifier implements DelivereeExtensionNotificationSender {
  constructor(
    private readonly delegate?: DelivereeExtensionNotificationSender,
    private readonly mode = "intake_only_no_discord_send"
  ) {}

  async send(notification: DelivereeExtensionNotification) {
    console.log(JSON.stringify({
      action: notification.action,
      bookingId: notification.payload.bookingId,
      caseId: notification.recoveryCase.caseId,
      deviceId: notification.deviceId,
      driverName: notification.payload.driverName,
      event: "deliveree_extension_signal",
      etaText: notification.payload.etaText,
      failureReason: notification.payload.failureReason,
      lateText: notification.payload.lateText,
      observedAt: notification.payload.observedAt,
      pageUrl: notification.payload.pageUrl,
      plateNumber: notification.payload.plateNumber,
      status: notification.payload.status
    }));

    if (!this.delegate) {
      return;
    }

    try {
      await this.delegate.send(notification);
      console.log(JSON.stringify({
        action: notification.action,
        bookingId: notification.payload.bookingId,
        deviceId: notification.deviceId,
        event: "deliveree_extension_discord_rest_sent",
        status: notification.payload.status
      }));
    } catch (error) {
      console.error("Deliveree extension REST notifier gagal mengirim alert Discord.", error);
    }
  }

  async sendConnectionTest(notification: DelivereeExtensionConnectionTestNotification) {
    console.log(JSON.stringify({
      deviceId: notification.deviceId,
      event: "deliveree_extension_connection_test",
      mode: this.mode,
      observedAt: notification.observedAt
    }));

    if (this.delegate) {
      await this.delegate.sendConnectionTest(notification);
      return;
    }

    throw new DelivereeExtensionDiscordTestDisabledError("Intake-only runner tidak mengirim Discord test. Gunakan runtime bot utama untuk test Discord.");
  }
}

const loggedPageStateFingerprints = new Map<string, string>();

function pageStateLogKey(state: { deviceId: string; pageUrl: string }) {
  return `${state.deviceId}|${state.pageUrl}`;
}

function pageStateLogFingerprint(state: {
  bookingId?: string;
  eventType?: string;
  etaText?: string;
  lateText?: string;
  plateNumber?: string;
  pageKind: string;
  status?: string;
  statusText?: string;
}) {
  return [
    state.pageKind,
    state.bookingId || "",
    state.status || "",
    state.statusText || "",
    state.eventType || "",
    state.etaText || "",
    state.lateText || "",
    state.plateNumber || ""
  ].join("|");
}

if (!env.DELIVEREE_EXTENSION_TOKEN) {
  throw new Error("DELIVEREE_EXTENSION_TOKEN wajib diisi untuk menjalankan Deliveree intake-only server.");
}

function createNotifier() {
  if (!env.DELIVEREE_INTAKE_DISCORD_ENABLED) {
    return new ConsoleDelivereeExtensionNotifier();
  }

  if (!env.DISCORD_TOKEN) {
    throw new Error("DISCORD_TOKEN wajib diisi jika DELIVEREE_INTAKE_DISCORD_ENABLED=true.");
  }

  return new ConsoleDelivereeExtensionNotifier(
    new DiscordRestDelivereeExtensionNotifier({
      botToken: env.DISCORD_TOKEN,
      channelId: env.DELIVEREE_ALERT_CHANNEL_ID
    }),
    "intake_only_discord_rest"
  );
}

const server = createDelivereeExtensionIntakeServer({
  allowedDeviceIds: env.DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS,
  notifier: createNotifier(),
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
      etaText: state.etaText,
      lateText: state.lateText,
      manualTest: context.manualTest,
      pageKind: state.pageKind,
      pageUrl: state.pageUrl,
      plateNumber: state.plateNumber,
      receivedAt: state.receivedAt,
      status: state.status,
      statusStartedAt: state.statusStartedAt,
      statusText: state.statusText
    }));
  },
  store: createDelivereeCaseStore(),
  token: env.DELIVEREE_EXTENSION_TOKEN
});

server.listen(env.DELIVEREE_EXTENSION_PORT, env.DELIVEREE_EXTENSION_HOST, () => {
  console.log(`Deliveree intake aktif di ${env.DELIVEREE_EXTENSION_HOST}:${env.DELIVEREE_EXTENSION_PORT}.`);
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

