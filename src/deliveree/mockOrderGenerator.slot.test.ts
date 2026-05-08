import { test } from "node:test";
import assert from "node:assert";
import { isMockOrderSlot } from "./mockOrderGenerator.js";

test("Mock Order Generator - isMockOrderSlot accepts 1-10", () => {
  for (let i = 1; i <= 10; i++) {
    assert.strictEqual(isMockOrderSlot(i), true);
  }
  
  assert.strictEqual(isMockOrderSlot(0), false);
  assert.strictEqual(isMockOrderSlot(11), false);
  assert.strictEqual(isMockOrderSlot(5.5), false);
});
