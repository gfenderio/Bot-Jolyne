import { test } from "node:test";
import assert from "node:assert";
import { formatDelivereeRecoveryAlertMessage, type DelivereeRecoveryAlert } from "./discordNotifier.js";

test("Discord Notifier - Recovery Alert uses 'menit' for stalled time", () => {
  const alert: DelivereeRecoveryAlert = {
    bookingId: "TEST-001",
    reason: "Test Reason",
    recommendation: "Test Recommendation",
    severity: "warning",
    status: "driver_assigned",
    stalledForSeconds: 15 * 60
  };

  const message = formatDelivereeRecoveryAlertMessage(alert);
  
  assert.match(message, /Stalled: 15 menit/);
  assert.doesNotMatch(message, /detik/);
});
