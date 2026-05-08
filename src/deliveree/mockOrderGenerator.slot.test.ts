import { test } from "node:test";
import assert from "node:assert";
import {
  createReplacementMockOrder,
  getMockOrderSlotFromBookingId,
  isMockOrderSlot
} from "./mockOrderGenerator.js";

test("Mock Order Generator - isMockOrderSlot accepts 1-10", () => {
  for (let i = 1; i <= 10; i++) {
    assert.strictEqual(isMockOrderSlot(i), true);
  }
  
  assert.strictEqual(isMockOrderSlot(0), false);
  assert.strictEqual(isMockOrderSlot(11), false);
  assert.strictEqual(isMockOrderSlot(5.5), false);
});

test("Mock Order Generator - derives slot and replacement order from booking ID", () => {
  assert.strictEqual(getMockOrderSlotFromBookingId("MOCK-006"), 6);
  assert.strictEqual(getMockOrderSlotFromBookingId("MOCK-006-R1"), 6);
  assert.strictEqual(getMockOrderSlotFromBookingId("19320032"), 1);
  assert.strictEqual(getMockOrderSlotFromBookingId("unknown"), undefined);

  const replacementOrder = createReplacementMockOrder("MOCK-006");

  assert.ok(replacementOrder);
  assert.match(replacementOrder.bookingId, /^MOCK-006-R\d+$/);
  assert.strictEqual(replacementOrder.scenario, "normal_completed");
  assert.strictEqual(replacementOrder.slot, 6);
});
