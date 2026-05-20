import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { classifyDelivereePageText } from "./webClassifier.js";
import type { DelivereePageClassification } from "./webClassifier.js";

export type DelivereeWebInspection = {
  bookingId: string;
  classification: DelivereePageClassification;
  inspectedAt: string;
  screenshotPath: string;
  url: string;
};

export type DelivereePrepareDraftResult = {
  inspection: DelivereeWebInspection;
  prepared: false;
  reason: string;
};

type DelivereeWebClientOptions = {
  profileDir: string;
  screenshotDir: string;
};

export function extractBookingIdFromDelivereeUrl(url: string) {
  const match = /\/bookings\/([^/?#]+)/.exec(url);
  return match?.[1] ?? encodeURIComponent(url).slice(0, 48);
}

export class DelivereeWebClient {
  constructor(private readonly options: DelivereeWebClientOptions) {}

  async inspectBooking(url: string): Promise<DelivereeWebInspection> {
    await mkdir(this.options.profileDir, { recursive: true });
    await mkdir(this.options.screenshotDir, { recursive: true });

    const bookingId = extractBookingIdFromDelivereeUrl(url);
    const context = await chromium.launchPersistentContext(this.options.profileDir, {
      headless: true,
      viewport: {
        height: 900,
        width: 1440
      }
    });

    try {
      const page = await context.newPage();
      await page.goto(url, {
        timeout: 45_000,
        waitUntil: "domcontentloaded"
      });
      await page.waitForLoadState("networkidle", {
        timeout: 10_000
      }).catch(() => undefined);

      const pageText = await page.locator("body").innerText({
        timeout: 5_000
      }).catch(() => "");
      const inspectedAt = new Date().toISOString();
      const screenshotPath = join(
        this.options.screenshotDir,
        `${bookingId}-${inspectedAt.replace(/[:.]/g, "-")}.png`
      );

      await page.screenshot({
        fullPage: true,
        path: screenshotPath
      });

      return {
        bookingId,
        classification: classifyDelivereePageText(pageText),
        inspectedAt,
        screenshotPath,
        url
      };
    } finally {
      await context.close();
    }
  }

  async prepareReorderDraft(url: string): Promise<DelivereePrepareDraftResult> {
    const inspection = await this.inspectBooking(url);

    return {
      inspection,
      prepared: false,
      reason: [
        "Sistem berhenti sebelum klik tindakan reorder apa pun.",
        "Gunakan screenshot untuk review manual sampai tombol aman terverifikasi dari UI live."
      ].join(" ")
    };
  }
}


