import { mapDelivereeStatusToLabel } from "./statusMapper.js";
import type { DelivereeOrderSnapshot } from "./types.js";

export interface DelivereeNotifier {
  sendOrderUpdate(order: DelivereeOrderSnapshot): Promise<void>;
}

export function formatDelivereeDiscordMessage(order: DelivereeOrderSnapshot) {
  const lines = [
    `[Jolyne] Update Deliveree #${order.bookingId}`,
    `Status: ${mapDelivereeStatusToLabel(order.status)}`
  ];

  if (order.driverName) {
    lines.push(`Driver: ${order.driverName}`);
  }

  if (order.vehiclePlate) {
    lines.push(`Plat: ${order.vehiclePlate}`);
  }

  if (order.eta) {
    lines.push(`ETA: ${order.eta}`);
  }

  return lines.join("\n");
}

export class DiscordWebhookNotifier implements DelivereeNotifier {
  constructor(private readonly webhookUrl?: string) {}

  async sendOrderUpdate(order: DelivereeOrderSnapshot) {
    const content = formatDelivereeDiscordMessage(order);

    if (!this.webhookUrl) {
      console.log("DISCORD_WEBHOOK_URL belum diisi. Simulasi kirim Discord:");
      console.log(content);
      return;
    }

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content })
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} ${responseText}`.trim());
    }
  }
}
