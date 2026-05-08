import { mapDelivereeStatusToLabel } from "./statusMapper.js";
import type { DelivereeOrderSnapshot } from "./types.js";

export type DelivereeRecoverySeverity = "info" | "warning" | "critical";

export type DelivereeRecoveryAlert = {
  bookingId: string;
  driverName?: string;
  reason: string;
  recommendation: string;
  retryCount?: number;
  severity: DelivereeRecoverySeverity;
  stalledForSeconds?: number;
  status: DelivereeOrderSnapshot["status"];
  vehiclePlate?: string;
};

export interface DelivereeNotifier {
  sendRecoveryAlert(alert: DelivereeRecoveryAlert): Promise<void>;
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

function mapSeverityToLabel(severity: DelivereeRecoverySeverity) {
  const labels: Record<DelivereeRecoverySeverity, string> = {
    critical: "Critical",
    info: "Info",
    warning: "Warning"
  };

  return labels[severity];
}

export function formatDelivereeRecoveryAlertMessage(alert: DelivereeRecoveryAlert) {
  const lines = [
    `[Jolyne] Deliveree Recovery Alert #${alert.bookingId}`,
    `Severity: ${mapSeverityToLabel(alert.severity)}`,
    `Status: ${mapDelivereeStatusToLabel(alert.status)}`,
    `Reason: ${alert.reason}`,
    `Recommendation: ${alert.recommendation}`
  ];

  if (alert.driverName) {
    lines.push(`Driver: ${alert.driverName}`);
  }

  if (alert.vehiclePlate) {
    lines.push(`Plat: ${alert.vehiclePlate}`);
  }

  if (alert.stalledForSeconds !== undefined) {
    lines.push(`Stalled: ${alert.stalledForSeconds} menit`);
  }

  if (alert.retryCount !== undefined) {
    lines.push(`Retry Count: ${alert.retryCount}`);
  }

  return lines.join("\n");
}

export class DiscordWebhookNotifier implements DelivereeNotifier {
  constructor(private readonly webhookUrl?: string) {}

  async sendOrderUpdate(order: DelivereeOrderSnapshot) {
    await this.sendContent(formatDelivereeDiscordMessage(order));
  }

  async sendRecoveryAlert(alert: DelivereeRecoveryAlert) {
    await this.sendContent(formatDelivereeRecoveryAlertMessage(alert));
  }

  private async sendContent(content: string) {
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
