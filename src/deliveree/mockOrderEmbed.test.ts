import assert from "node:assert";
import { test } from "node:test";
import { buildMockOrderMessage } from "./mockOrderEmbed.js";
import type { DelivereeOrderSnapshot } from "./types.js";

type ButtonComponentJson = {
  disabled?: boolean;
  label?: string;
};

function getButtonLabels(message: ReturnType<typeof buildMockOrderMessage>) {
  const row = message.components[0].toJSON();
  return row.components.map((component) => (component as ButtonComponentJson).label);
}

test("Mock Order Embed - includes recovery controls", () => {
  const order: DelivereeOrderSnapshot = {
    bookingId: "MOCK-002",
    driverName: "Sari",
    scenario: "cancelled",
    status: "cancelled",
    updatedAt: "2026-05-08T03:00:00.000Z",
    vehiclePlate: "B 1002 JLY"
  };
  const message = buildMockOrderMessage({
    bookingId: order.bookingId,
    changed: true,
    order
  });
  const embed = message.embeds[0].toJSON();

  assert.strictEqual(embed.title, "Kyou Deliveree Mock Order");
  assert.match(JSON.stringify(embed), /Outcome Simulasi/);
  assert.deepStrictEqual(getButtonLabels(message), ["Refresh Status", "Reorder", "Cancel"]);
});

test("Mock Order Embed - disables controls when completed", () => {
  const message = buildMockOrderMessage({
    bookingId: "MOCK-001",
    order: {
      bookingId: "MOCK-001",
      status: "completed",
      updatedAt: "2026-05-08T03:00:00.000Z"
    }
  });
  const row = message.components[0].toJSON();
  const buttons = row.components as ButtonComponentJson[];

  assert.strictEqual(buttons[0].disabled, true);
  assert.strictEqual(buttons[1].disabled, true);
  assert.strictEqual(buttons[2].disabled, true);
});

