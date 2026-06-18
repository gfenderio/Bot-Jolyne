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
import { createDelivereeCaseStore } from "./liveRuntime.js";
import type { DelivereeRecoveryCase } from "./caseStore.js";
import {
  parseDelivereeExtensionPageStatePayload,
  parseDelivereeExtensionStatusPayload,
  type DelivereeExtensionEventType,
  type DelivereeExtensionPageStatePayload,
  type DelivereeExtensionStatusPayload
} from "./extensionDomExtractor.js";

export type StoredDelivereeExtensionPageState = DelivereeExtensionPageStatePayload & {
  deviceId: string;
  receivedAt: string;
  statusStartedAt?: string;
};

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
const pageStates = new Map<string, StoredDelivereeExtensionPageState>();

setInterval(() => {
  rateLimiter.cleanup();
}, 60_000).unref();

function hasSameStatusContext(
  previous: StoredDelivereeExtensionPageState | undefined,
  next: DelivereeExtensionPageStatePayload
) {
  return Boolean(
    previous
    && previous.pageKind === next.pageKind
    && previous.bookingId === next.bookingId
    && previous.status === next.status
  );
}

export function recordDelivereeExtensionPageState(
  deviceId: string,
  pageState: DelivereeExtensionPageStatePayload
) {
  const previous = pageStates.get(deviceId);
  const now = new Date().toISOString();
  const stored: StoredDelivereeExtensionPageState = {
    ...pageState,
    deviceId,
    receivedAt: now,
    statusStartedAt: hasSameStatusContext(previous, pageState)
      ? previous?.statusStartedAt
      : pageState.observedAt
  };

  pageStates.set(deviceId, stored);
  return stored;
}

export function getLatestDelivereeExtensionPageState(deviceId?: string) {
  if (deviceId) {
    return pageStates.get(deviceId);
  }

  return [...pageStates.values()]
    .sort((left, right) => new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime())[0];
}

export function clearDelivereeExtensionPageStates() {
  pageStates.clear();
}

function toPageStatePayload(payload: DelivereeExtensionStatusPayload): DelivereeExtensionPageStatePayload {
  return {
    bookingId: payload.bookingId,
    driverName: payload.driverName,
    eventType: payload.eventType,
    etaMinutes: payload.etaMinutes,
    etaText: payload.etaText,
    failureReason: payload.failureReason,
    lateText: payload.lateText,
    observedAt: payload.observedAt,
    pageKind: "booking_detail",
    pageUrl: payload.pageUrl,
    plateNumber: payload.plateNumber,
    schemaVersion: payload.schemaVersion,
    status: payload.status,
    statusText: payload.statusText,
    vehicleDescription: payload.vehicleDescription
  };
}

export type DelivereeExtensionIntakeAction =
  | "deduped"
  | "ignored"
  | DelivereeExtensionEventType;

export type DelivereeExtensionIntakeDecision = {
  action: DelivereeExtensionIntakeAction;
  caseId: string;
  deduped: boolean;
  ok: true;
};

export type DelivereeExtensionNotification = {
  action: DelivereeExtensionEventType;
  deviceId: string;
  payload: DelivereeExtensionStatusPayload;
  recoveryCase: DelivereeRecoveryCase;
};

export type DelivereeExtensionNotificationSendResult = {
  channelId?: string;
  messageId?: string;
};

export type DelivereeExtensionConnectionTestNotification = {
  deviceId: string;
  observedAt: string;
};

export interface DelivereeExtensionNotificationSender {
  send(notification: DelivereeExtensionNotification): Promise<DelivereeExtensionNotificationSendResult | void>;
  sendConnectionTest(notification: DelivereeExtensionConnectionTestNotification): Promise<void>;
}

export interface DelivereeExtensionCaseStore {
  listCases?(): Promise<DelivereeRecoveryCase[]>;
  appendActionLog?(caseId: string, entry: {
    action: string;
    at?: string;
    nonce?: string;
    note?: string;
  }): Promise<DelivereeRecoveryCase | undefined>;
  upsertObservation(input: {
    bookingId: string;
    destinationCount?: number;
    deviceId?: string;
    driverName?: string;
    duplicateUrl?: string;
    etaText?: string;
    eventType?: DelivereeExtensionEventType;
    failureReason?: string;
    jobNo?: string;
    lastHeartbeatAt?: string;
    lastPageKind?: DelivereeExtensionPageStatePayload["pageKind"];
    lateText?: string;
    observedAt?: string;
    plateNumber?: string;
    recordUnchangedAction?: boolean;
    serviceType?: string;
    status: DelivereeExtensionStatusPayload["status"];
    statusStartedAt?: string;
    statusText?: string;
    totalDistanceKm?: number;
    url: string;
    vehicleDescription?: string;
  }): Promise<{
    changed: boolean;
    recoveryCase: DelivereeRecoveryCase;
  }>;
  setAlertMessage?(caseId: string, channelId: string, messageId: string): Promise<DelivereeRecoveryCase | undefined>;
}

export type DelivereeExtensionIntakeOptions = {
  allowedDeviceIds: string[];
  notifier: DelivereeExtensionNotificationSender;
  onPageState?: (
    state: StoredDelivereeExtensionPageState,
    context: { manualTest: boolean }
  ) => void | Promise<void>;
  store: DelivereeExtensionCaseStore;
  token?: string;
  discordClient?: import("discord.js").Client<true>;
};

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export class DelivereeExtensionDiscordTestDisabledError extends Error {
  constructor(message = "Discord test tidak aktif di mode intake-only.") {
    super(message);
  }
}

function writeCorsHeaders(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Deliveree-Device-Id, X-Deliveree-Manual-Test");
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

function isTruthyHeader(value: string | string[] | undefined) {
  return getHeaderValue(value)?.trim().toLowerCase() === "true";
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

async function handleDelivereeExtensionCommands(
  deviceId: string,
  store: DelivereeExtensionCaseStore
) {
  if (!store.listCases || !store.appendActionLog) {
    return {
      command: null,
      ok: true
    };
  }

  const cases = await store.listCases();
  const candidates = cases
    .filter((recoveryCase) => recoveryCase.deviceId === deviceId)
    .flatMap((recoveryCase) => recoveryCase.actionLog
      .filter((entry) => entry.action === "turn_off_auto_retry" && entry.nonce)
      .map((entry) => ({ entry, recoveryCase })))
    .sort((left, right) => right.entry.at.localeCompare(left.entry.at));

  for (const candidate of candidates) {
    const consumed = candidate.recoveryCase.actionLog.some((entry) => (
      entry.action === "auto_retry_disable_command_consumed"
      && entry.nonce === candidate.entry.nonce
    ));

    if (consumed) {
      continue;
    }

    await store.appendActionLog(candidate.recoveryCase.caseId, {
      action: "auto_retry_disable_command_consumed",
      nonce: candidate.entry.nonce,
      note: `Disable Auto Retry command delivered to ${deviceId}.`
    });

    return {
      command: {
        bookingId: candidate.recoveryCase.bookingId,
        caseId: candidate.recoveryCase.caseId,
        issuedAt: candidate.entry.at,
        reason: "Auto Retry dimatikan dari Discord.",
        type: "disable_auto_retry"
      },
      ok: true
    };
  }

  return {
    command: null,
    ok: true
  };
}

function getMvpEventType(payload: DelivereeExtensionStatusPayload): DelivereeExtensionEventType | undefined {
  if (payload.eventType) {
    return payload.eventType;
  }

  if (payload.status === "cancelled" || payload.status === "no_driver_found") {
    return "order_failed";
  }

  if (payload.status === "driver_assigned") {
    return "order_created";
  }

  if (
    payload.status === "searching_driver"
    || payload.status === "active_booking"
    || payload.status === "going_to_pickup"
    || payload.status === "waiting_pickup"
    || payload.status === "going_to_destination"
    || payload.status === "arrived_destination"
  ) {
    return "order_created";
  }

  return undefined;
}

function getNotificationAction(
  changed: boolean,
  payload: DelivereeExtensionStatusPayload,
  recoveryCase: DelivereeRecoveryCase
): DelivereeExtensionIntakeAction {
  const eventType = getMvpEventType(payload);

  if (!eventType) {
    return "ignored";
  }

  if (eventType === "order_created") {
    const previousEntries = recoveryCase.actionLog.slice(0, -1);
    const alreadyObservedActiveOrder = previousEntries.some((entry) => {
      if (!entry.afterStatus) {
        return false;
      }

      return getMvpEventType({
        ...payload,
        eventType: undefined,
        status: entry.afterStatus
      }) === "order_created";
    });

    if (alreadyObservedActiveOrder) {
      return "deduped";
    }
  }

  if (
    eventType.startsWith("driver_retry_")
    || eventType === "driver_assigned_after_retry"
  ) {
    return eventType;
  }

  return changed ? eventType : "deduped";
}

function toObservationInputFromStatusPayload(
  payload: DelivereeExtensionStatusPayload,
  deviceId: string,
  statusStartedAt?: string
) {
  return {
    bookingId: payload.bookingId,
    destinationCount: payload.destinationCount,
    deviceId,
    driverName: payload.driverName,
    duplicateUrl: payload.duplicateUrl,
    etaText: payload.etaText,
    eventType: getMvpEventType(payload),
    failureReason: payload.failureReason,
    jobNo: payload.jobNo,
    lastHeartbeatAt: payload.observedAt,
    lastPageKind: "booking_detail" as const,
    lateText: payload.lateText,
    observedAt: payload.observedAt,
    plateNumber: payload.plateNumber,
    retryAttempt: payload.retryAttempt,
    retryStopReason: payload.retryStopReason,
    serviceType: payload.serviceType,
    status: payload.status,
    statusStartedAt,
    statusText: payload.statusText,
    totalDistanceKm: payload.totalDistanceKm,
    url: payload.pageUrl,
    vehicleDescription: payload.vehicleDescription
  };
}

export async function handleDelivereeExtensionStatusEvent(
  payload: DelivereeExtensionStatusPayload,
  deviceId: string,
  options: Pick<DelivereeExtensionIntakeOptions, "notifier" | "store">
): Promise<DelivereeExtensionIntakeDecision> {
  const storedPageState = recordDelivereeExtensionPageState(deviceId, toPageStatePayload(payload));
  const { changed, recoveryCase } = await options.store.upsertObservation({
    ...toObservationInputFromStatusPayload(payload, deviceId, storedPageState.statusStartedAt),
    lastHeartbeatAt: storedPageState.receivedAt
  });
  const action = getNotificationAction(changed, payload, recoveryCase);

  if (action !== "deduped" && action !== "ignored") {
    const sendResult = await options.notifier.send({
      action,
      deviceId,
      payload,
      recoveryCase
    });

    if (sendResult?.channelId && sendResult.messageId) {
      await options.store.setAlertMessage?.(recoveryCase.caseId, sendResult.channelId, sendResult.messageId);
    }
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

async function handleDelivereeExtensionPageState(
  body: string,
  deviceId: string,
  options: Pick<DelivereeExtensionIntakeOptions, "onPageState" | "store">,
  context: { manualTest: boolean }
) {
  const pageState = parseDelivereeExtensionPageStatePayload(parseJsonBody(body));
  const stored = recordDelivereeExtensionPageState(deviceId, pageState);

  let caseId: string | undefined;

  if (stored.bookingId && stored.status) {
    const upsert = await options.store.upsertObservation({
      bookingId: stored.bookingId,
      deviceId,
      driverName: stored.driverName,
      etaText: stored.etaText,
      eventType: stored.eventType,
      failureReason: stored.failureReason,
      lastHeartbeatAt: stored.receivedAt,
      lastPageKind: stored.pageKind,
      lateText: stored.lateText,
      observedAt: stored.receivedAt,
      plateNumber: stored.plateNumber,
      recordUnchangedAction: false,
      status: stored.status,
      statusStartedAt: stored.statusStartedAt,
      statusText: stored.statusText,
      url: stored.pageUrl,
      vehicleDescription: stored.vehicleDescription
    });

    caseId = upsert.recoveryCase.caseId;
  }

  await options.onPageState?.(stored, context);

  return {
    action: "page_state_recorded",
    caseId,
    deviceId,
    ok: true,
    pageKind: stored.pageKind,
    serverTime: stored.receivedAt,
    status: stored.status,
    statusStartedAt: stored.statusStartedAt
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
    "/deliveree/extension/commands",
    "/deliveree/extension/health",
    "/deliveree/extension/page-state",
    "/deliveree/extension/status",
    "/deliveree/extension/test-discord",
    "/machitan/pick-proof",
    "/machitan/pack-proof",
    "/machitan/ws-inbox",
    "/machitan/shipping"
  ];

  if (!validPaths.includes(pathname) || !["GET", "POST"].includes(request.method || "")) {
    sendJson(response, 404, {
      error: "not_found",
      ok: false
    });
    return;
  }

  if (pathname === "/machitan/pick-proof" || pathname === "/machitan/pack-proof") {
    if (!options.discordClient) {
      sendJson(response, 500, { error: "Discord client not configured", ok: false });
      return;
    }
    try {
      const { handleMachitanPickProof } = await import("../machitan/pickProofIntake.js");
      await handleMachitanPickProof(request, response, options.discordClient);
    } catch (e) {
      console.error(e);
      sendJson(response, 500, { error: "Internal server error handling Machitan request", ok: false });
    }
    return;
  }

  if (pathname === "/machitan/shipping") {
    if (!options.discordClient) {
      sendJson(response, 500, { error: "Discord client not configured", ok: false });
      return;
    }
    try {
      const { handleMachitanShipping } = await import("../machitan/shippingIntake.js");
      await handleMachitanShipping(request, response, options.discordClient);
    } catch (e) {
      console.error(e);
      sendJson(response, 500, { error: "Internal server error handling Machitan shipping request", ok: false });
    }
    return;
  }

  if (pathname === "/machitan/ws-report-now") {
    if (request.headers.authorization !== "Bearer kyou-machitan-secret-2026") {
      sendJson(response, 401, { error: "Unauthorized", ok: false });
      return;
    }
    if (!options.discordClient) {
      sendJson(response, 500, { error: "Discord client not configured", ok: false });
      return;
    }
    try {
      const { generateWsReportWorkbook } = await import("../machitan/dailyReportScheduler.js");
      const { getAndClearWsInboxProofs } = await import("../machitan/wsInboxStore.js");
      const { AttachmentBuilder, EmbedBuilder, TextChannel } = await import("discord.js");
      const wsProofs = await getAndClearWsInboxProofs();
      if (wsProofs.length === 0) { sendJson(response, 200, { message: "No WS data in store", ok: true }); return; }
      const todayStr = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "long", year: "numeric" });
      const earliestWs = wsProofs.reduce((min, p) => p.timestamp < min.timestamp ? p : min, wsProofs[0]);
      const wsDateStr = new Date(earliestWs.timestamp).toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "long", year: "numeric" });
      const wsBuffer = await generateWsReportWorkbook(wsProofs, wsDateStr);
      const channel = await options.discordClient.channels.fetch("1501899831268868106");
      if (!channel || !channel.isTextBased()) { sendJson(response, 500, { error: "Channel not found", ok: false }); return; }
      const surplusCount = wsProofs.flatMap(p => p.items).filter(i => i.selisih > 0).length;
      const deficitCount = wsProofs.flatMap(p => p.items).filter(i => i.selisih < 0).length;
      const embed = new EmbedBuilder()
        .setColor(0x1565C0)
        .setTitle(`🏭 Rekap WS Opname — ${wsDateStr}`)
        .setDescription(`Manual trigger. Rekap opname per source.`)
        .addFields(
          { name: "Total Submit", value: `${wsProofs.length}`, inline: true },
          { name: "Total Item", value: `${wsProofs.flatMap(p => p.items).length}`, inline: true },
          { name: "⬆️ Lebih", value: `${surplusCount} item`, inline: true },
          { name: "⬇️ Kurang", value: `${deficitCount} item`, inline: true },
        )
        .setFooter({ text: `Manual trigger ${todayStr}` })
        .setTimestamp();
      const attachment = new AttachmentBuilder(Buffer.from(wsBuffer), { name: `Rekap_WS_Opname_${wsDateStr.replace(/ /g, "_")}.xlsx` });
      await (channel as any).send({ embeds: [embed], files: [attachment] });
      sendJson(response, 200, { message: "WS report sent", ok: true });
    } catch (e) {
      console.error(e);
      sendJson(response, 500, { error: "Failed to send WS report", ok: false });
    }
    return;
  }

  if (pathname === "/machitan/ws-inbox") {
    if (!options.discordClient) {
      sendJson(response, 500, { error: "Discord client not configured", ok: false });
      return;
    }
    try {
      const { handleWsInboxIntake } = await import("../machitan/wsInboxIntake.js");
      await handleWsInboxIntake(request, response);
    } catch (e) {
      console.error(e);
      sendJson(response, 500, { error: "Internal server error handling WS Inbox request", ok: false });
    }
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

    if (pathname === "/deliveree/extension/commands") {
      if (request.method !== "GET") {
        sendJson(response, 405, {
          error: "method_not_allowed",
          ok: false
        });
        return;
      }

      sendJson(response, 200, await handleDelivereeExtensionCommands(deviceId, options.store));
      return;
    }



    if (request.method !== "POST") {
      sendJson(response, 405, {
        error: "method_not_allowed",
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

    if (pathname === "/deliveree/extension/page-state") {
      sendJson(response, 200, await handleDelivereeExtensionPageState(body, deviceId, options, {
        manualTest: isTruthyHeader(request.headers["x-deliveree-manual-test"])
      }));
      return;
    }

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

    if (error instanceof DelivereeExtensionDiscordTestDisabledError) {
      sendJson(response, 409, {
        code: "discord_test_disabled",
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
    driver_assigned_after_retry: "Auto Retry berhasil! Driver ditemukan.",
    driver_retry_clicked: "Driver masih belum ditemukan. Sudah kucoba pesan kembali, akan kulanjutkan pantau retry berikutnya.",
    driver_retry_detected: "Deliveree kehabisan driver. Auto Retry siap berjalan jika aktif.",
    driver_retry_page_changed: "Halaman berubah dari modal Retry. Auto Retry dipause sementara.",
    driver_retry_paused: "Auto Retry dipause. Cek status di popup atau halaman.",
    order_created: "Order baru sudah terbaca. Akan kupantau ya sampai statusnya aman atau butuh tindakan.",
    order_failed: "Order Deliveree gagal. Perlu dicek manual oleh tim."
  };

  return descriptions[action];
}

function statusColor(notification: DelivereeExtensionNotification) {
  if (notification.action === "order_failed") return 0xeb5757;
  if (notification.action === "driver_assigned_after_retry") return 0x27ae60;
  if (notification.action === "driver_retry_detected") return 0xf2994a;
  if (notification.action === "driver_retry_clicked") return 0x2d9cdb;
  if (notification.action.startsWith("driver_retry_")) return 0xf2c94c;
  return 0x2f80ed;
}

function fieldValue(value: string | number | undefined) {
  if (value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

export function buildDelivereeExtensionManualComponents(caseId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`deliv:turn_off_auto_retry:${caseId}`)
        .setLabel("Turn Off Auto Retry")
        .setStyle(ButtonStyle.Danger)
    )
  ];
}

export function buildDelivereeExtensionNotificationEmbed(notification: DelivereeExtensionNotification) {
  const fields = [
    {
      inline: true,
      name: "Booking",
      value: `#${notification.payload.bookingId}`
    },
    {
      inline: true,
      name: "Event",
      value: `\`${notification.action}\``
    },
    {
      inline: true,
      name: "Status",
      value: `\`${notification.payload.status}\``
    },
    {
      inline: true,
      name: "Info Status",
      value: fieldValue(notification.payload.statusText)
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

  const showDriverDetails = ["driver_assigned", "going_to_pickup", "waiting_pickup", "going_to_destination", "arrived_destination"].includes(notification.payload.status);

  if (notification.payload.driverName && showDriverDetails) {
    fields.push({
      inline: true,
      name: "Driver",
      value: notification.payload.driverName
    });
  }

  if (notification.payload.vehicleDescription && showDriverDetails) {
    fields.push({
      inline: true,
      name: "Kendaraan",
      value: notification.payload.vehicleDescription
    });
  }

  if (notification.payload.plateNumber && showDriverDetails) {
    fields.push({
      inline: true,
      name: "Plat",
      value: `\`${notification.payload.plateNumber}\``
    });
  }

  if (notification.payload.etaText) {
    fields.push({
      inline: true,
      name: "ETA",
      value: notification.payload.etaText
    });
  }

  if (notification.action === "order_created") {
    fields.push({
      inline: false,
      name: "Pantauan",
      value: "Extension lokal akan lanjut kirim heartbeat. Kalau driver gagal ditemukan, status berubah, atau butuh retry, Discord akan dikabari lagi."
    });
  }

  if (notification.payload.pageUrl) {
    fields.push({
      inline: false,
      name: "Halaman",
      value: notification.payload.pageUrl
    });
  }

  if (notification.payload.failureReason && !notification.action.startsWith("driver_retry_")) {
    fields.push({
      inline: false,
      name: "Reason",
      value: notification.payload.failureReason
    });
  }

  if (notification.action === "driver_retry_clicked" && notification.payload.retryAttempt !== undefined) {
    fields.push({
      inline: true,
      name: "Attempt",
      value: String(notification.payload.retryAttempt)
    });
    if (notification.payload.retryDelayUsed !== undefined) {
      fields.push({
        inline: true,
        name: "Delay",
        value: `${notification.payload.retryDelayUsed}s`
      });
    }
    if (notification.payload.retryDurationSeconds !== undefined) {
      fields.push({
        inline: true,
        name: "Duration",
        value: `${Math.floor(notification.payload.retryDurationSeconds / 60)}m ${notification.payload.retryDurationSeconds % 60}s`
      });
    }
  }

  if (notification.action === "driver_assigned_after_retry" && notification.payload.retryTotalDurationSeconds !== undefined) {
    fields.push({
      inline: true,
      name: "Total Retry Duration",
      value: `${Math.floor(notification.payload.retryTotalDurationSeconds / 60)}m ${notification.payload.retryTotalDurationSeconds % 60}s`
    });
    if (notification.payload.retryAttempt !== undefined) {
      fields.push({
        inline: true,
        name: "Total Coba Pesan",
        value: String(notification.payload.retryAttempt)
      });
    }
  }

  if (notification.action === "driver_retry_paused" || notification.action === "driver_retry_page_changed") {
    if (notification.payload.retryStopReason) {
      fields.push({
        inline: false,
        name: "Stop Reason",
        value: notification.payload.retryStopReason
      });
    }
  }

  return new EmbedBuilder()
    .setColor(statusColor(notification))
    .setTitle(`Kyou Deliveree: Order Alert #${notification.payload.bookingId}`)
    .setDescription(describeAction(notification.action))
    .addFields(fields)
    .setFooter({
      text: "Source: Kyou Deliveree Partner"
    })
    .setTimestamp(new Date(notification.payload.observedAt));
}

export function buildDelivereeExtensionNotificationMessage(notification: DelivereeExtensionNotification) {
  return {
    components: buildDelivereeExtensionManualComponents(notification.recoveryCase.caseId),
    embeds: [buildDelivereeExtensionNotificationEmbed(notification)]
  } satisfies MessageCreateOptions;
}

export function buildDelivereeExtensionConnectionTestEmbed(notification: DelivereeExtensionConnectionTestNotification) {
  return new EmbedBuilder()
    .setColor(0x27ae60)
    .setTitle("Kyou Deliveree Extension Test OK")
    .setDescription("Chrome extension berhasil terhubung ke Kyou Deliveree dan Discord.")
    .addFields([
      {
        inline: true,
        name: "Device",
        value: `\`${notification.deviceId}\``
      },
      {
        inline: true,
        name: "Mode",
        value: "`Kyou Deliveree Partner`"
      }
    ])
    .setFooter({
      text: "Source: extension popup test"
    })
    .setTimestamp(new Date(notification.observedAt));
}

export class DiscordBotDelivereeExtensionNotifier implements DelivereeExtensionNotificationSender {
  constructor(private readonly client: Client<true>) {}

  async send(notification: DelivereeExtensionNotification) {
    try {
      return await this.sendToAlertChannel(buildDelivereeExtensionNotificationMessage(notification));
    } catch (error) {
      console.error("Deliveree extension intake gagal mengirim alert Discord.", error);
      return undefined;
    }
  }

  async sendConnectionTest(notification: DelivereeExtensionConnectionTestNotification) {
    await this.sendToAlertChannel({
      embeds: [buildDelivereeExtensionConnectionTestEmbed(notification)]
    });
  }

  private async sendToAlertChannel(message: MessageCreateOptions): Promise<DelivereeExtensionNotificationSendResult> {
    const channel = await this.client.channels.fetch(env.DELIVEREE_ALERT_CHANNEL_ID);

    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${env.DELIVEREE_ALERT_CHANNEL_ID} tidak bisa dikirimi pesan.`);
    }

    const sentMessage = await channel.send(message);

    return {
      channelId: sentMessage.channelId,
      messageId: sentMessage.id
    };
  }
}

type DiscordRestFetch = typeof fetch;

export class DiscordRestDelivereeExtensionNotifier implements DelivereeExtensionNotificationSender {
  constructor(private readonly options: {
    botToken: string;
    channelId: string;
    fetchImpl?: DiscordRestFetch;
  }) {}

  async send(notification: DelivereeExtensionNotification) {
    const components = buildDelivereeExtensionManualComponents(notification.recoveryCase.caseId)
      .map((row) => row.toJSON());

    return this.sendToAlertChannel({
      components,
      embeds: [buildDelivereeExtensionNotificationEmbed(notification).toJSON()]
    });
  }

  async sendConnectionTest(notification: DelivereeExtensionConnectionTestNotification) {
    await this.sendToAlertChannel({
      embeds: [buildDelivereeExtensionConnectionTestEmbed(notification).toJSON()]
    });
  }

  private async sendToAlertChannel(message: { components?: unknown[]; embeds: unknown[] }): Promise<DelivereeExtensionNotificationSendResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`https://discord.com/api/v10/channels/${this.options.channelId}/messages`, {
      body: JSON.stringify(message),
      headers: {
        "Authorization": `Bot ${this.options.botToken}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Discord REST send failed: HTTP ${response.status}${errorText ? ` ${errorText}` : ""}`);
    }

    const body = await response.json().catch(() => undefined) as { channel_id?: string; id?: string } | undefined;

    return {
      channelId: body?.channel_id,
      messageId: body?.id
    };
  }
}

export function startDelivereeExtensionIntake(client: Client<true>) {
  const server = createDelivereeExtensionIntakeServer({
    allowedDeviceIds: env.DELIVEREE_EXTENSION_ALLOWED_DEVICE_IDS,
    notifier: new DiscordBotDelivereeExtensionNotifier(client),
    store: createDelivereeCaseStore(),
    token: env.DELIVEREE_EXTENSION_TOKEN,
    discordClient: client
  });

  server.listen(env.DELIVEREE_EXTENSION_PORT, env.DELIVEREE_EXTENSION_HOST, () => {
    const delivereeStatus = env.DELIVEREE_EXTENSION_ENABLED && env.DELIVEREE_EXTENSION_TOKEN ? "aktif" : "disabled";
    console.log(`HTTP intake aktif di ${env.DELIVEREE_EXTENSION_HOST}:${env.DELIVEREE_EXTENSION_PORT} (Deliveree extension: ${delivereeStatus}).`);
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
