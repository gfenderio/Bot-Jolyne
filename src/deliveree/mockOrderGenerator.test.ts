import { test } from "node:test";
import assert from "node:assert";
import { getMockOrderOutcome } from "./mockOrderGenerator.js";

test("Mock Order Generator - Outcomes use 'menit' instead of 'detik'", () => {
  const warningOutcome = getMockOrderOutcome("stuck_driver_warning");
  assert.match(warningOutcome, /menit/);
  assert.doesNotMatch(warningOutcome, /detik/);

  const criticalOutcome = getMockOrderOutcome("stuck_driver_critical");
  assert.match(criticalOutcome, /menit/);
  assert.doesNotMatch(criticalOutcome, /detik/);
});
