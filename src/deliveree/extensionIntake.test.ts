import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonDelivereeCaseStore } from "./caseStore.js";
import {
  clearDelivereeExtensionPageStates,
  createDelivereeExtensionIntakeServer,
  DelivereeExtensionDiscordTestDisabledError,
  DiscordRestDelivereeExtensionNotifier,
  buildDelivereeExtensionNotificationEmbed,
  buildDelivereeExtensionManualComponents,
  getLatestDelivereeExtensionPageState,
  type StoredDelivereeExtensionPageState,
  type DelivereeExtensionConnectionTestNotification,
  type DelivereeExtensionNotification,
  type DelivereeExtensionNotificationSender
} from "./extensionIntake.js";
import type { DelivereeExtensionStatusPayload } from "./extensionDomExtractor.js";

class MemoryExtensionNotifier implements DelivereeExtensionNotificationSender {
  readonly connectionTests: DelivereeExtensionConnectionTestNotification[] = [];
  readonly notifications: DelivereeExtensionNotification[] = [];

  async send(notification: DelivereeExtensionNotification) {
    this.notifications.push(notification);
  }

  async sendConnectionTest(notification: DelivereeExtensionConnectionTestNotification) {
    this.connectionTests.push(notification);
  }
}

function buildPayload(overrides: Partial<DelivereeExtensionStatusPayload> = {}): DelivereeExtensionStatusPayload {
  return {
    bookingId: "19330506",
    destinationCount: 2,
    duplicateUrl: "https://webapp.deliveree.com/bookings/19330506/book_again/?area_id=3",
    jobNo: "RY-Zhuxin",
    observedAt: "2026-05-08T07:00:00.000Z",
    pageUrl: "https://webapp.deliveree.com/bookings/19330506",
    schemaVersion: 1,
    serviceType: "Van",
    status: "searching_driver",
    statusText: "Memilih",
    totalDistanceKm: 32,
    ...overrides
  };
}

async function withTestServer<T>(
  callback: (context: {
    notifier: MemoryExtensionNotifier;
    getPath: (path: string, headers?: Record<string, string>) => Promise<Response>;
    pageStates: StoredDelivereeExtensionPageState[];
    post: (payload: unknown, headers?: Record<string, string>) => Promise<Response>;
    postPath: (path: string, payload?: unknown, headers?: Record<string, string>) => Promise<Response>;
    store: JsonDelivereeCaseStore;
  }) => Promise<T>
) {
  const dir = await mkdtemp(join(tmpdir(), "jolyne-deliveree-extension-"));
  const notifier = new MemoryExtensionNotifier();
  const pageStates: StoredDelivereeExtensionPageState[] = [];
  const store = new JsonDelivereeCaseStore(join(dir, "cases.json"));
  const server = createDelivereeExtensionIntakeServer({
    allowedDeviceIds: ["yugi-browser"],
    notifier,
    onPageState(state) {
      pageStates.push(state);
    },
    store,
    token: "test-token"
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const postPath = (path: string, payload: unknown = {}, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, {
    body: JSON.stringify(payload),
    headers: {
      "Authorization": "Bearer test-token",
      "Content-Type": "application/json",
      "X-Deliveree-Device-Id": "yugi-browser",
      ...headers
    },
    method: "POST"
  });
  const post = (payload: unknown, headers: Record<string, string> = {}) => postPath(
    "/deliveree/extension/status",
    payload,
    headers
  );
  const getPath = (path: string, headers: Record<string, string> = {}) => fetch(`${baseUrl}${path}`, {
    headers: {
      "Authorization": "Bearer test-token",
      "X-Deliveree-Device-Id": "yugi-browser",
      ...headers
    },
    method: "GET"
  });

  try {
    return await callback({
      notifier,
      getPath,
      pageStates,
      post,
      postPath,
      store
    });
  } finally {
    clearDelivereeExtensionPageStates();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await rm(dir, {
      force: true,
      recursive: true
    });
  }
}

test("Deliveree Extension Intake - rejects missing token", async () => {
  await withTestServer(async ({ post }) => {
    const response = await post(buildPayload(), {
      "Authorization": ""
    });

    assert.strictEqual(response.status, 401);
  });
});

test("Deliveree Extension Intake - rejects disallowed device", async () => {
  await withTestServer(async ({ post }) => {
    const response = await post(buildPayload(), {
      "X-Deliveree-Device-Id": "other-browser"
    });

    assert.strictEqual(response.status, 403);
  });
});

test("Deliveree Extension Intake - health check validates local connection only", async () => {
  await withTestServer(async ({ notifier, postPath }) => {
    const response = await postPath("/deliveree/extension/health");
    const body = await response.json() as { action: string; deviceId: string; ok: boolean; serverTime: string };

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.action, "health_ok");
    assert.strictEqual(body.deviceId, "yugi-browser");
    assert.match(body.serverTime, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(notifier.notifications.length, 0);
    assert.strictEqual(notifier.connectionTests.length, 0);
  });
});

test("Deliveree Extension Intake - extension command delivers Discord auto retry shutdown once", async () => {
  await withTestServer(async ({ getPath, post, store }) => {
    await post(buildPayload({
      eventType: "driver_retry_clicked",
      retryAttempt: 1,
      status: "no_driver_found"
    }));
    await store.appendActionLog("19330506", {
      action: "turn_off_auto_retry",
      at: "2026-05-08T07:01:00.000Z",
      nonce: "nonce-disable",
      note: "Staff mematikan Auto Retry dari tombol Discord.",
      userId: "419213146209779713"
    });

    const firstResponse = await getPath("/deliveree/extension/commands");
    const firstBody = await firstResponse.json() as {
      command: { bookingId: string; type: string } | null;
      ok: boolean;
    };

    assert.strictEqual(firstResponse.status, 200);
    assert.strictEqual(firstBody.ok, true);
    assert.strictEqual(firstBody.command?.type, "disable_auto_retry");
    assert.strictEqual(firstBody.command?.bookingId, "19330506");

    const secondResponse = await getPath("/deliveree/extension/commands");
    const secondBody = await secondResponse.json() as { command: unknown; ok: boolean };

    assert.strictEqual(secondResponse.status, 200);
    assert.strictEqual(secondBody.ok, true);
    assert.strictEqual(secondBody.command, null);
  });
});

test("Deliveree Extension Intake - retry clicked notifies every retry attempt", async () => {
  await withTestServer(async ({ notifier, post, store }) => {
    const response = await post(buildPayload({
      eventType: "driver_retry_clicked",
      retryAttempt: 1,
      retryDelayUsed: 9,
      retryDurationSeconds: 9,
      status: "no_driver_found"
    }));
    const body = await response.json() as { action: string; deduped?: boolean; ok: boolean };
    const recoveryCase = await store.getCase("19330506");

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.action, "driver_retry_clicked");
    assert.strictEqual(notifier.notifications.length, 1);
    assert.strictEqual(notifier.notifications[0].action, "driver_retry_clicked");
    assert.strictEqual(recoveryCase?.retryAttempt, 1);
  });
});

test("Deliveree Extension Intake - Discord test sends a test notification", async () => {
  await withTestServer(async ({ notifier, postPath }) => {
    const response = await postPath("/deliveree/extension/test-discord");
    const body = await response.json() as { action: string; deviceId: string; ok: boolean };

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.action, "discord_test_sent");
    assert.strictEqual(body.deviceId, "yugi-browser");
    assert.strictEqual(notifier.notifications.length, 0);
    assert.strictEqual(notifier.connectionTests.length, 1);
    assert.strictEqual(notifier.connectionTests[0].deviceId, "yugi-browser");
  });
});

test("Deliveree Extension Intake - Discord REST notifier sends embeds without gateway", async () => {
  const calls: Array<{
    body: unknown;
    headers: Headers;
    method: string | undefined;
    url: string;
  }> = [];
  const notifier = new DiscordRestDelivereeExtensionNotifier({
    botToken: "discord-token",
    channelId: "1501899831268868106",
    fetchImpl: async (input, init) => {
      calls.push({
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
        method: init?.method,
        url: String(input)
      });
      return new Response("{}", {
        status: 200
      });
    }
  });

  await notifier.send({
    action: "order_failed",
    deviceId: "yugi-browser",
    payload: buildPayload({
      eventType: "order_failed",
      failureReason: "BATAL",
      status: "cancelled",
      statusText: "BATAL"
    }),
    recoveryCase: {
      actionLog: [],
      bookingId: "19330506",
      caseId: "19330506",
      lastObservedAt: "2026-05-08T07:00:00.000Z",
      lastStatusChangeAt: "2026-05-08T07:00:00.000Z",
      retryCount: 0,
      status: "cancelled",
      url: "https://webapp.deliveree.com/bookings/19330506"
    }
  });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "https://discord.com/api/v10/channels/1501899831268868106/messages");
  assert.strictEqual(calls[0].method, "POST");
  assert.strictEqual(calls[0].headers.get("Authorization"), "Bot discord-token");
  assert.match(JSON.stringify(calls[0].body), /Kyou Deliveree: Order Alert #19330506/);
});

test("Deliveree Extension Intake - builds safe manual case controls only", () => {
  const components = buildDelivereeExtensionManualComponents("19330506");
  const json = JSON.stringify(components.map((component) => component.toJSON()));

  assert.match(json, /Turn Off Auto Retry/);
  assert.doesNotMatch(json, /Need Follow Up/);
  assert.doesNotMatch(json, /Manual Reorder Done/);
  assert.doesNotMatch(json, /Close Case/);
  assert.doesNotMatch(json, /Ignore/);
  assert.doesNotMatch(json, /Prepare Reorder/);
  assert.doesNotMatch(json, /Refresh/);
});

test("Deliveree Extension Intake - reports disabled Discord test explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jolyne-deliveree-extension-"));
  const server = createDelivereeExtensionIntakeServer({
    allowedDeviceIds: ["yugi-browser"],
    notifier: {
      async send() {
        return undefined;
      },
      async sendConnectionTest() {
        throw new DelivereeExtensionDiscordTestDisabledError(
          "Intake-only runner tidak mengirim Discord test. Gunakan runtime bot utama untuk test Discord."
        );
      }
    },
    store: new JsonDelivereeCaseStore(join(dir, "cases.json")),
    token: "test-token"
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/deliveree/extension/test-discord`, {
      headers: {
        "Authorization": "Bearer test-token",
        "X-Deliveree-Device-Id": "yugi-browser"
      },
      method: "POST"
    });
    const body = await response.json() as { code: string; error: string; ok: boolean };

    assert.strictEqual(response.status, 409);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.code, "discord_test_disabled");
    assert.match(body.error, /Intake-only runner/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await rm(dir, {
      force: true,
      recursive: true
    });
  }
});

test("Deliveree Extension Intake - records latest page state heartbeat", async () => {
  await withTestServer(async ({ notifier, pageStates, postPath }) => {
    const response = await postPath("/deliveree/extension/page-state", {
      observedAt: "2026-05-08T07:00:00.000Z",
      pageKind: "draft_page",
      pageUrl: "https://webapp.deliveree.com/bookings/new",
      schemaVersion: 1
    });
    const body = await response.json() as { action: string; ok: boolean; pageKind: string };
    const latest = getLatestDelivereeExtensionPageState("yugi-browser");

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.action, "page_state_recorded");
    assert.strictEqual(body.pageKind, "draft_page");
    assert.strictEqual(latest?.pageKind, "draft_page");
    assert.strictEqual(latest?.deviceId, "yugi-browser");
    assert.strictEqual(pageStates.length, 1);
    assert.strictEqual(pageStates[0].pageKind, "draft_page");
    assert.strictEqual(notifier.notifications.length, 0);
  });
});

test("Deliveree Extension Intake - keeps status start time while heartbeat status is unchanged", async () => {
  await withTestServer(async ({ postPath }) => {
    await postPath("/deliveree/extension/page-state", {
      bookingId: "19330506",
      observedAt: "2026-05-08T07:00:00.000Z",
      pageKind: "booking_detail",
      pageUrl: "https://webapp.deliveree.com/bookings/19330506",
      schemaVersion: 1,
      status: "searching_driver"
    });
    const second = await postPath("/deliveree/extension/page-state", {
      bookingId: "19330506",
      observedAt: "2026-05-08T07:05:00.000Z",
      pageKind: "booking_detail",
      pageUrl: "https://webapp.deliveree.com/bookings/19330506",
      schemaVersion: 1,
      status: "searching_driver"
    });
    const secondBody = await second.json() as { statusStartedAt: string };

    const latest = getLatestDelivereeExtensionPageState("yugi-browser");

    assert.strictEqual(latest?.status, "searching_driver");
    assert.strictEqual(latest?.statusStartedAt, "2026-05-08T07:00:00.000Z");
    assert.strictEqual(secondBody.statusStartedAt, "2026-05-08T07:00:00.000Z");
  });
});

test("Deliveree Extension Intake - page-state heartbeat updates recovery case without alert noise", async () => {
  await withTestServer(async ({ notifier, postPath, store }) => {
    const response = await postPath("/deliveree/extension/page-state", {
      bookingId: "19343630",
      driverName: "Driver Test",
      observedAt: "2026-05-09T09:00:00.000Z",
      pageKind: "booking_detail",
      pageUrl: "https://webapp.deliveree.com/bookings/19343630/tracking",
      plateNumber: "B1234ABC",
      schemaVersion: 1,
      status: "going_to_pickup",
      statusText: "Menuju Penjemputan",
      vehicleDescription: "Van"
    });
    await postPath("/deliveree/extension/page-state", {
      bookingId: "19343630",
      driverName: "Driver Test",
      observedAt: "2026-05-09T09:01:00.000Z",
      pageKind: "booking_detail",
      pageUrl: "https://webapp.deliveree.com/bookings/19343630/tracking",
      plateNumber: "B1234ABC",
      schemaVersion: 1,
      status: "going_to_pickup",
      statusText: "Menuju Penjemputan",
      vehicleDescription: "Van"
    });
    const body = await response.json() as { caseId?: string; ok: boolean };
    const recoveryCase = await store.getCase("19343630");

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.caseId, "19343630");
    assert.strictEqual(recoveryCase?.status, "going_to_pickup");
    assert.strictEqual(recoveryCase?.driverName, "Driver Test");
    assert.strictEqual(recoveryCase?.plateNumber, "B1234ABC");
    assert.strictEqual(recoveryCase?.vehicleDescription, "Van");
    assert.strictEqual(recoveryCase?.actionLog.length, 1);
    assert.strictEqual(notifier.notifications.length, 0);
  });
});

test("Deliveree Extension Intake - accepts valid payload and dedupes repeated status", async () => {
  await withTestServer(async ({ notifier, post }) => {
    const first = await post(buildPayload({
      eventType: "order_created"
    }));
    const firstBody = await first.json() as { action: string; deduped: boolean; ok: boolean };
    const second = await post(buildPayload({
      eventType: "order_created"
    }));
    const secondBody = await second.json() as { action: string; deduped: boolean; ok: boolean };

    assert.strictEqual(first.status, 200);
    assert.strictEqual(firstBody.ok, true);
    assert.strictEqual(firstBody.action, "order_created");
    assert.strictEqual(firstBody.deduped, false);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(secondBody.action, "deduped");
    assert.strictEqual(secondBody.deduped, true);
    assert.strictEqual(notifier.notifications.length, 1);
    assert.strictEqual(notifier.notifications[0].action, "order_created");
  });
});

test("Deliveree Extension Intake - new order notification tells operator it will be monitored", async () => {
  await withTestServer(async ({ notifier, post }) => {
    await post(buildPayload({
      eventType: "order_created",
      jobNo: "JB-1234567",
      pageUrl: "https://webapp.deliveree.com/bookings/19330506",
      serviceType: "Pickup (1 Ton)",
      status: "searching_driver",
      totalDistanceKm: 14.8
    }));

    const embed = buildDelivereeExtensionNotificationEmbed(notifier.notifications[0]).toJSON();
    const serialized = JSON.stringify(embed);

    assert.match(serialized, /Akan kupantau ya/);
    assert.match(serialized, /Pantauan/);
    assert.match(serialized, /JB-1234567/);
    assert.match(serialized, /14\.8 km/);
    assert.match(serialized, /https:\/\/webapp\.deliveree\.com\/bookings\/19330506/);
  });
});

test("Deliveree Extension Intake - does not repeat order_created for normal route progress", async () => {
  await withTestServer(async ({ notifier, post }) => {
    const first = await post(buildPayload({
      eventType: "order_created",
      status: "searching_driver"
    }));
    const progress = await post(buildPayload({
      etaMinutes: 11,
      etaText: "11 MNT",
      eventType: "order_created",
      lateText: "46m telat",
      observedAt: "2026-05-08T07:05:00.000Z",
      plateNumber: "B9847FAZ",
      status: "going_to_destination",
      statusText: undefined
    }));
    const progressBody = await progress.json() as { action: string; deduped: boolean; ok: boolean };

    assert.strictEqual(first.status, 200);
    assert.strictEqual(progress.status, 200);
    assert.strictEqual(progressBody.ok, true);
    assert.strictEqual(progressBody.action, "deduped");
    assert.strictEqual(progressBody.deduped, true);
    assert.strictEqual(notifier.notifications.length, 1);
    assert.strictEqual(notifier.notifications[0].action, "order_created");
  });
});

test("Deliveree Extension Intake - notifies order failure after created signal", async () => {
  await withTestServer(async ({ notifier, post }) => {
    await post(buildPayload({
      eventType: "order_created"
    }));
    const cancelled = await post(buildPayload({
      eventType: "order_failed",
      failureReason: "Batal",
      observedAt: "2026-05-08T07:05:00.000Z",
      status: "cancelled",
      statusText: "Batal"
    }));
    const cancelledBody = await cancelled.json() as { action: string; deduped: boolean; ok: boolean };

    assert.strictEqual(cancelled.status, 200);
    assert.strictEqual(cancelledBody.ok, true);
    assert.strictEqual(cancelledBody.action, "order_failed");
    assert.strictEqual(cancelledBody.deduped, false);
    assert.strictEqual(notifier.notifications.length, 2);
    assert.strictEqual(notifier.notifications[1].action, "order_failed");
    assert.strictEqual(notifier.notifications[1].payload.duplicateUrl, "https://webapp.deliveree.com/bookings/19330506/book_again/?area_id=3");
  });
});

test("Deliveree Extension Intake - ignores non-MVP statuses", async () => {
  await withTestServer(async ({ notifier, post }) => {
    const response = await post(buildPayload({
      eventType: undefined,
      status: "completed",
      statusText: "Selesai"
    }));
    const body = await response.json() as { action: string; deduped: boolean; ok: boolean };

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.action, "ignored");
    assert.strictEqual(body.deduped, false);
    assert.strictEqual(notifier.notifications.length, 0);
  });
});



