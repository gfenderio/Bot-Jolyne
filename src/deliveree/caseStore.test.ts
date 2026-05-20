import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonDelivereeCaseStore } from "./caseStore.js";

test("Deliveree Case Store - persists observations and action log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jolyne-deliveree-case-"));
  const filePath = join(dir, "cases.json");
  const store = new JsonDelivereeCaseStore(filePath);

  const first = await store.upsertObservation({
    bookingId: "19330506",
    status: "searching_driver",
    url: "https://webapp.deliveree.com/bookings/19330506"
  });
  const second = await store.upsertObservation({
    bookingId: "19330506",
    status: "no_driver_found",
    url: "https://webapp.deliveree.com/bookings/19330506"
  });
  await store.appendActionLog("19330506", {
    action: "refresh",
    nonce: "abc",
    userId: "419213146209779713"
  });
  const hasNonce = await store.hasActionNonce("19330506", "abc");

  const stored = JSON.parse(await readFile(filePath, "utf8")) as { cases: Array<{ actionLog: unknown[] }> };

  assert.strictEqual(first.changed, true);
  assert.strictEqual(second.changed, true);
  assert.strictEqual(hasNonce, true);
  assert.strictEqual(stored.cases.length, 1);
  assert.strictEqual(stored.cases[0].actionLog.length, 3);

  await rm(dir, { force: true, recursive: true });
});

test("Deliveree Case Store - updates heartbeat context without flooding action log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jolyne-deliveree-case-"));
  const filePath = join(dir, "cases.json");
  const store = new JsonDelivereeCaseStore(filePath);

  await store.upsertObservation({
    bookingId: "19343630",
    deviceId: "yugi-browser",
    driverName: "Driver Test",
    lastHeartbeatAt: "2026-05-09T09:00:00.000Z",
    lastPageKind: "booking_detail",
    observedAt: "2026-05-09T09:00:00.000Z",
    plateNumber: "B1234ABC",
    status: "going_to_pickup",
    statusStartedAt: "2026-05-09T09:00:00.000Z",
    statusText: "Menuju Penjemputan",
    url: "https://webapp.deliveree.com/bookings/19343630"
  });
  await store.upsertObservation({
    bookingId: "19343630",
    deviceId: "yugi-browser",
    driverName: "Driver Test",
    lastHeartbeatAt: "2026-05-09T09:01:00.000Z",
    lastPageKind: "booking_detail",
    observedAt: "2026-05-09T09:01:00.000Z",
    plateNumber: "B1234ABC",
    recordUnchangedAction: false,
    status: "going_to_pickup",
    statusStartedAt: "2026-05-09T09:00:00.000Z",
    statusText: "Menuju Penjemputan",
    url: "https://webapp.deliveree.com/bookings/19343630"
  });

  const recoveryCase = await store.getCase("19343630");

  assert.strictEqual(recoveryCase?.actionLog.length, 1);
  assert.strictEqual(recoveryCase?.lastHeartbeatAt, "2026-05-09T09:01:00.000Z");
  assert.strictEqual(recoveryCase?.lastObservedAt, "2026-05-09T09:01:00.000Z");
  assert.strictEqual(recoveryCase?.lastStatusChangeAt, "2026-05-09T09:00:00.000Z");
  assert.strictEqual(recoveryCase?.driverName, "Driver Test");
  assert.strictEqual(recoveryCase?.plateNumber, "B1234ABC");
  assert.strictEqual(recoveryCase?.statusText, "Menuju Penjemputan");

  await rm(dir, { force: true, recursive: true });
});
