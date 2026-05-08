import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type MessageCreateOptions
} from "discord.js";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { createSignedDelivereeButtonId } from "../security/signedButton.js";
import { createDelivereeCaseStore } from "./liveRuntime.js";
import type { DelivereeRecoveryCase } from "./caseStore.js";
import {
  parseDelivereeExtensionStatusPayload,
  type DelivereeExtensionStatusPayload
} from "./extensionDomExtractor.js";

class SimpleRateLimiter {
  private requests = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs = 60_000, maxRequests = 60) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  check(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    const validTimestamps = timestamps.filter((timestamp) => now - timestamp < this.windowMs);

    if (validTimestamps.length >= this.maxRequests) {
      return false;
    }

    validTimestamps.push(now);
    this.requests.set(key, validTimestamps);
    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.requests) {
      const validTimestamps = timestamps.filter((timestamp) => now - timestamp < this.windowMs);
      if (validTimestamps.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, validTimestamps);
      }
    }
  }
}

const rateLimiter = new SimpleRateLimiter(60_000, 60);

setInterval(() => {
  rateLimiter.cleanup();
}, 60_000).unref();

function isDriverAssignedStatus(status: string) {
  return status === "driver_assigned" || status === "on_delivery" || status === "arrived_at_pickup";
}

function getStuckDriverMinutes(recoveryCase: DelivereeRecoveryCase) {
  const now = Date.now();
  const lastChange = new Date(recoveryCase.lastStatusChangeAt).getTime();
  return Math.floor((now - lastChange) / 1000 / 60);
}

function shouldSendStuckDriverAlert(recoveryCase: DelivereeRecoveryCase) {
  if (!isDriverAssignedStatus(recoveryCase.status)) {
    return false;
  }

  if (recoveryCase.stuckDriverAlertSentAt) {
    return false;
  }

  if (recoveryCase.silencedAt) {
    return false;
  }

  const stuckMinutes = getStuckDriverMinutes(recoveryCase);
  return stuckMinutes >= env.DELIVEREE_STUCK_DRIVER_WARNING_MINUTES;
}

export type DelivereeExtensionIntakeAction =
  | "booking_observed"
  | "cancelled_alert"
  | "deduped"
  | "status_changed"
  | "stuck_driver_alert";

export type DelivereeExtensionIntakeDecision = {
  action: DelivereeExtensionIntakeAction;
  caseId: string;
  deduped: boolean;
  ok: true;
};

export type DelivereeExtensionNotification = {
  action: Exclude<DelivereeExtensionIntakeAction, "deduped">;
  deviceId: string;
  payload: DelivereeExtensionStatusPayload;
  recoveryCase: DelivereeRecoveryCase;
};

export type DelivereeExtensionConnectionTestNotification = {
  deviceId: string;
  observedAt: string;
};

export interface DelivereeExtensionNotificationSender {
  send(notification: DelivereeExtensionNotification): Promise<void>;
  sendConnectionTest(notification: DelivereeExtensionConnectionTestNotification): Promise<void>;
}

export interface DelivereeExtensionCaseStore {
  upsertObservation(input: {
    bookingId: string;
    status: DelivereeExtensionStatusPayload["status"];
    url: string;
  }): Promise<{
    changed: boolean;
    recoveryCase: DelivereeRecoveryCase;
  }>;
  markStuckDriverAlertSent(caseId: string): Promise<DelivereeRecoveryCase | undefined>;
}

export type DelivereeExtensionIntakeOptions = {
  allowedDeviceIds: string[];
  notifier: DelivereeExtensionNotificationSender;
  store: DelivereeExtensionCaseStore;
  token: string;
};

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function writeCorsHeaders(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Deliveree-Device-Id");
  response.setHeader("Access-Control-Allow-Methods", "OPTIONS, POST");
  response.setHeader("Access-Control-Allow-Origin", "*");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  writeCorsHeaders(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function getHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function readRequestBody(request: IncomingMessage, maxBytes = 64 * 1024) {
  let body = "";

  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);

    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new HttpError(413, "Payload terlalu besar.");
    }
  }

  return body;
}

function assertAuthorized(request: IncomingMessage, options: DelivereeExtensionIntakeOptions) {
  const authorization = getHeaderValue(request.headers.authorization);
  const expected = `Bearer ${options.token}`;

  if (authorization !== expected) {
    throw new HttpError(401, "Token extension tidak valid.");
  }

  const deviceId = getHeaderValue(request.headers["x-deliveree-device-id"])?.trim();

  if (!deviceId) {
    throw new HttpError(401, "Header X-Deliveree-Device-Id wajib diisi.");
  }

  if (!options.allowedDeviceIds.includes(deviceId)) {
    throw new HttpError(403, "Device extension tidak diizinkan.");
  }

  return deviceId;
}

function getNotificationAction(
  changed: boolean,
  recoveryCase: DelivereeRecoveryCase,
  payload: DelivereeExtensionStatusPayload
): DelivereeExtensionIntakeAction {
  if (!changed) {
    return "deduped";
  }

  if (payload.status === "cancelled") {
    return "cancelled_alert";
  }

  return recoveryCase.actionLog.length === 1 ? "booking_observed" : "status_changed";
}

export async function handleDelivereeExtensionStatusEvent(
  payload: DelivereeExtensionStatusPayload,
  deviceId: string,
  options: Pick<DelivereeExtensionIntakeOptions, "notifier" | "store">
): Promise<DelivereeExtensionIntakeDecision> {
  const { changed, recoveryCase } = await options.store.upsertObservation({
    bookingId: payload.bookingId,
    status: payload.status,
    url: payload.pageUrl
  });
  const action = getNotificationAction(changed, recoveryCase, payload);

  if (action !== "deduped") {
    await options.notifier.send({
      action,
      deviceId,
      payload,
      recoveryCase
    });
  }

  if (shouldSendStuckDriverAlert(recoveryCase)) {
    await options.notifier.send({
      action: "stuck_driver_alert",
      deviceId,
      payload,
      recoveryCase
    });
    await options.store.markStuckDriverAlertSent(recoveryCase.caseId);
  }

  return {
    action,
    caseId: recoveryCase.caseId,
    deduped: action === "deduped",
    ok: true
  };
}

function parseJsonBody(body: string) {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, "Body harus JSON valid.");
  }
}

function getRequestPathname(request: IncomingMessage) {
  return new URL(request.url || "/", "http://127.0.0.1").pathname;
}

async function handleDelivereeExtensionHealthCheck(deviceId: string) {
  return {
    action: "health_ok",
    deviceId,
    ok: true,
    serverTime: new Date().toISOString()
  } as const;
}

async function handleDelivereeExtensionDiscordTest(
  deviceId: string,
  options: Pick<DelivereeExtensionIntakeOptions, "notifier">
) {
  const observedAt = new Date().toISOString();

  await options.notifier.sendConnectionTest({
    deviceId,
    observedAt
  });

  return {
    action: "discord_test_sent",
    deviceId,
    ok: true,
    serverTime: observedAt
  } as const;
}

export async function handleDelivereeExtensionHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: DelivereeExtensionIntakeOptions
) {
  if (request.method === "OPTIONS") {
    writeCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }

  const pathname = getRequestPathname(request);
  const validPaths = [
    "/deliveree/extension/health",
    "/deliveree/extension/status",
    "/deliveree/extension/test-discord"
  ];

  if (request.method !== "POST" || !validPaths.includes(pathname)) {
    sendJson(response, 404, {
      error: "not_found",
      ok: false
    });
    return;
  }

  try {
    const deviceId = assertAuthorized(request, options);

    if (!rateLimiter.check(deviceId)) {
      sendJson(response, 429, {
        error: "rate_limit_exceeded",
        ok: false
      });
      return;
    }

    if (pathname === "/deliveree/extension/health") {
      sendJson(response, 200, await handleDelivereeExtensionHealthCheck(deviceId));
      return;
    }

    if (pathname === "/deliveree/extension/test-discord") {
      sendJson(response, 200, await handleDelivereeExtensionDiscordTest(deviceId, options));
      return;
    }

    const body = await readRequestBody(request);
    const payload = parseDelivereeExtensionStatusPayload(parseJsonBody(body));
    const decision = await handleDelivereeExtensionStatusEvent(payload, deviceId, options);

    sendJson(response, 200, decision);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, error.statusCode, {
        error: error.message,
        ok: false
      });
      return;
    }

    if (error instanceof ZodError) {
      sendJson(response, 400, {
        error: "Payload extension tidak valid.",
        issues: error.issues.map((issue) => issue.path.join(".")).filter(Boolean),
        ok: false
      });
      return;
    }

    console.error("Deliveree extension intake gagal memproses request.", error);
    sendJson(response, 500, {
      error: "internal_error",
      ok: false
    });
  }
}

export function createDelivereeExtensionIntakeServer(options: DelivereeExtensionIntakeOptions) {
  return createServer((request, response) => {
    void handleDelivereeExtensionHttpRequest(request, response, options);
  });
}

function describeAction(action: DelivereeExtensionNotification["action"]) {
  const descriptions: Record<DelivereeExtensionNotification["action"], string> = {
    booking_observed: "Order baru terdeteksi oleh extension lokal.",
    cancelled_alert: "Order terdeteksi batal. Siapkan review replacement/reorder secara manual.",
    status_changed: "Status order berubah sejak observasi sebelumnya.",
    stuck_driver_alert: "Driver assigned tapi tidak ada progress. Perlu follow up atau reorder."
  };

  return descriptions[action];
}

function statusColor(notification: DelivereeExtensionNotification) {
  if (notification.payload.status === "cancelled") {
    return 0xeb5757;
  }

  if (notification.payload.status === "completed") {
    return 0x27ae60;
  }

  if (notification.action === "stuck_driver_alert") {
    return 0xf39c12;
  }

  return notification.action === "booking_observed" ? 0x2f80ed : 0xf2c94c;
}

function fieldValue(value: string | number | undefined) {
  if (value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

export function buildDelivereeExtensionNotificationEmbed(notification: DelivereeExtensionNotification) {
  const fields = [
    {
      inline: true,
      name: "Status",
      value: `\`${notification.payload.status}\``
    },
    {
      inline: true,
      name: "Device",
      value: `\`${notification.deviceId}\``
    },
    {
      inline: true,
      name: "Service",
      value: fieldValue(notification.payload.serviceType)
    },
    {
      inline: true,
      name: "Jarak",
      value: notification.payload.totalDistanceKm === undefined ? "-" : `${notification.payload.totalDistanceKm} km`
    },
    {
      inline: true,
      name: "Tujuan",
      value: fieldValue(notification.payload.destinationCount)
    },
    {
      inline: true,
      name: "No. Job",
      value: fieldValue(notification.payload.jobNo)
    }
  ];

  if (notification.action === "stuck_driver_alert") {
    const stuckMinutes = getStuckDriverMinutes(notification.recoveryCase);
    fields.push({
      inline: true,
      name: "Stuck Duration",
      value: `${stuckMinutes} menit`
    });
  }

  if (notification.payload.duplicateUrl) {
    fields.push({
      inline: false,
      name: "Duplicate URL",
      value: notification.payload.duplicateUrl
    });
  }

  return new EmbedBuilder()
    .setColor(statusColor(notification))
    .setTitle(`[Jolyne] Deliveree #${notification.payload.bookingId}`)
    .setDescription(describeAction(notification.action))
    .addFields(fields)
    .setFooter({
      text: "Source: local Chrome extension, read-only"
    })
    .setTimestamp(new Date(notification.payload.observedAt));
}

export function buildDelivereeExtensionConnectionTestEmbed(notification: DelivereeExtensionConnectionTestNotification) {
  return new EmbedBuilder()
    .setColor(0x27ae60)
    .setTitle("[Jolyne] Deliveree extension test OK")
    .setDescription("Chrome extension berhasil terhubung ke Jolyne dan Discord.")
    .addFields([
      {
        inline: true,
        name: "Device",
        value: `\`${notification.deviceId}\``
      },
      {
        inline: true,
        name: "Mode",
        value: "`read-only local extension`"
      }
    ])
    .setFooter({
      text: "Source: extension popup test"
    })
    .setTimestamp(new Date(notification.observedAt));
}

function buildDelivereeRecoveryButtons(caseId: string, action: DelivereeExtensionNotification["action"]) {
  if (!env.DELIVEREE_BUTTON_SIGNING_SECRET) {
    return [];
  }

  const buttons = [];

  if (action === "cancelled_alert" || action === "stuck_driver_alert") {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(createSignedDelivereeButtonId({
          action: "manual_reorder",
          caseId,
          secret: env.DELIVEREE_BUTTON_SIGNING_SECRET
        }))
        .setLabel("Sudah Reorder Manual")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(createSignedDelivereeButtonId({
          action: "need_followup",
          caseId,
          secret: env.DELIVEREE_BUTTON_SIGNING_SECRET
        }))
        .setLabel("Butuh Follow Up")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(createSignedDelivereeButtonId({
          action: "ignore",
          caseId,
          secret: env.DELIVEREE_BUTTON_SIGNING_SECRET
        }))
        .setLabel("Abaikan")
        .setStyle(ButtonStyle.Secondary)
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(createSignedDelivereeButtonId({
        action: "refresh",
        caseId,
        secret: env.DELIVEREE_BUTTON_SIGNING_SECRET
      }))
      .setLabel("Refresh Status")
      .setStyle(ButtonStyle.Secondary)
  );

  if (buttons.length === 0) {
    return [];
  }

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
}

export class DiscordBotDelivereeExtensionNotifier implements DelivereeExtensionNotificationSender {
  constructor(private readonly client: Client<true>) {}

  async send(notification: DelivereeExtensionNotification) {
    try {
      await this.sendToAlertChannel({
        components: buildDelivereeRecoveryButtons(notification.recoveryCase.caseId, notification.action),
        embeds: [buildDelivereeExtensionNotificationEmbed(notification)]
      });
    } catch (error) {
      console.error("Deliveree extension intake gagal mengirim alert Discord.", error);
    }
  }

  async sendConnectionTest(notification: DelivereeExtensionConnectionTestNotification) {
    await this.sendToAlertChannel({
      embeds: [buildDelivereeExtensionConnectionTestEmbed(notification)]
    });
  }

  private async sendToAlertChannel(message: MessageCreateOptions) {
    const channel = await this.client.channels.fetch(env.DELIVEREE_ALERT_CHANNEL_ID);

    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${env.DELIVEREE_ALERT_CHANNEL_ID} tidak bisa dikirimi pesan.`);
    }

    await channel.send(message);
  }
}

export function startDelivereeExtensionIntake(client: Client<true>) {
  if (!env.DELIVEREE_EXTENSION_ENABLED) {
    console.log("Deliveree extension intake tidak aktif karena DELIVEREE_EXTENSION_ENABLED belum true.");
    return () => undefined;
  }

  if (!env.DELIVEREE_EXTENSION_TOKEN) {
    console.warn("Deliveree extension intake tidak aktif karena DELIVEREE_EXTENSION_TOKEN belum diisi.");
    return () => undefined;
  }

  const server = createDelivereeExtensionIntakeServer({
    allowedDeviceIds: env.DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS,
    notifier: new DiscordBotDelivereeExtensionNotifier(client),
    store: createDelivereeCaseStore(),
    token: env.DELIVEREE_EXTENSION_TOKEN
  });

  server.listen(env.DELIVEREE_EXTENSION_PORT, "127.0.0.1", () => {
    console.log(`Deliveree extension intake aktif di http://127.0.0.1:${env.DELIVEREE_EXTENSION_PORT}.`);
  });

  server.on("error", (error) => {
    console.error("Deliveree extension intake server error.", error);
  });

  return () => {
    closeServer(server);
  };
}

function closeServer(server: Server) {
  server.close((error) => {
    if (error) {
      console.error("Gagal menutup Deliveree extension intake server.", error);
    }
  });
}
