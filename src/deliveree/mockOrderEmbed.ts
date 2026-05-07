import { EmbedBuilder } from "discord.js";
import { formatMockOrderInitialStatus } from "./mockOrderGenerator.js";
import type { CreatedMockOrder } from "./mockOrderGenerator.js";

export function buildMockOrderCreatedEmbed(order: CreatedMockOrder) {
  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle("[Jolyne] Mock Order Dibuat")
    .addFields(
      {
        name: "Booking ID",
        value: `\`${order.bookingId}\``,
        inline: true
      },
      {
        name: "Slot",
        value: String(order.slot),
        inline: true
      },
      {
        name: "Scenario",
        value: `\`${order.scenario}\``,
        inline: false
      },
      {
        name: "Outcome Simulasi",
        value: order.outcome,
        inline: false
      },
      {
        name: "Status Awal",
        value: formatMockOrderInitialStatus(order.initialStatus),
        inline: true
      }
    )
    .setFooter({ text: "Jolyne Deliveree Recovery" })
    .setTimestamp();
}
