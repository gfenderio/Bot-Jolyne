import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonDelivereeCaseStore } from "./caseStore.js";
import {
  createDelivereeExtensionIntakeServer,
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
    post: (payload: unknown, headers?: Record<string, string>) => Promise<Response>;
    postPath: (path: string, payload?: unknown, headers?: Record<string, string>) => Promise<Response>;
  }) => Promise<T>
) {
  const dir = await mkdtemp(join(tmpdir(), "jolyne-deliveree-extension-"));
  const notifier = new MemoryExtensionNotifier();
  const server = createDelivereeExtensionIntakeServer({
    allowedDeviceIds: ["yugi-browser"],
    notifier,
    store: new JsonDelivereeCaseStore(join(dir, "cases.json")),
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

  try {
    return await callback({
      notifier,
      post,
      postPath
    });
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
