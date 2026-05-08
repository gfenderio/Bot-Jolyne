import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  extractDelivereeExtensionStatus,
  type DelivereeExtensionAnchorSnapshot,
  type DelivereeExtensionDetailRowSnapshot,
  type DelivereeExtensionPageSnapshot
} from "./extensionDomExtractor.js";

function stripTags(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAttribute(value: string, attributeName: string) {
  const match = value.match(new RegExp(`${attributeName}="([^"]*)"`, "i"));
  return match?.[1];
}

function extractBadge(html: string) {
  const match = html.match(/<div\s+([^>]*class="[^"]*badge-status[^"]*"[^>]*)>([\s\S]*?)<\/div>/i);

  if (!match) {
    return {};
  }

  return {
    badgeClassNames: [extractAttribute(match[1], "class") ?? ""],
    badgeText: stripTags(match[2])
  };
}

function extractAnchors(html: string): DelivereeExtensionAnchorSnapshot[] {
  const anchors: DelivereeExtensionAnchorSnapshot[] = [];
  const anchorRegex = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = extractAttribute(match[1], "href");

    if (href) {
      anchors.push({
        href,
        text: stripTags(match[2])
      });
    }
  }

  return anchors;
}

function extractDetailRows(html: string): DelivereeExtensionDetailRowSnapshot[] {
  const rows: DelivereeExtensionDetailRowSnapshot[] = [];
  const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;

  for (const match of html.matchAll(rowRegex)) {
    rows.push({
      label: stripTags(match[1]),
      value: stripTags(match[2])
    });
  }

  return rows;
}

async function readFixture(name: string, pageUrl: string): Promise<DelivereeExtensionPageSnapshot> {
  const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  const titleText = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1];

  return {
    ...extractBadge(html),
    anchors: extractAnchors(html),
    bodyText: stripTags(html),
    detailRows: extractDetailRows(html),
    observedAt: "2026-05-08T07:00:00.000Z",
    pageUrl,
    titleText: titleText ? stripTags(titleText) : undefined
  };
}

test("Deliveree Extension Extractor - extracts completed order fixture", async () => {
  const payload = extractDelivereeExtensionStatus(await readFixture(
    "extension-completed-order.html",
    "https://webapp.deliveree.com/bookings/19320032"
  ));

  assert.strictEqual(payload.status, "completed");
  assert.strictEqual(payload.bookingId, "19320032");
  assert.strictEqual(payload.duplicateUrl, "https://webapp.deliveree.com/bookings/19320032/book_again/?area_id=3");
  assert.strictEqual(payload.serviceType, "Mobil XL");
  assert.strictEqual(payload.totalDistanceKm, 28);
  assert.strictEqual(payload.destinationCount, 1);
});

test("Deliveree Extension Extractor - extracts cancelled order fixture", async () => {
  const payload = extractDelivereeExtensionStatus(await readFixture(
    "extension-cancelled-order.html",
    "https://webapp.deliveree.com/bookings/19330506"
  ));

  assert.strictEqual(payload.status, "cancelled");
  assert.strictEqual(payload.bookingId, "19330506");
  assert.strictEqual(payload.duplicateUrl, "https://webapp.deliveree.com/bookings/19330506/book_again/?area_id=3");
  assert.strictEqual(payload.serviceType, "Van");
  assert.strictEqual(payload.totalDistanceKm, 32);
  assert.strictEqual(payload.destinationCount, 2);
  assert.strictEqual(payload.jobNo, "RY-Zhuxin");
});

test("Deliveree Extension Extractor - handles unknown fixture without crashing", async () => {
  const payload = extractDelivereeExtensionStatus(await readFixture(
    "extension-unknown-order.html",
    "https://webapp.deliveree.com/bookings/19339999"
  ));

  assert.strictEqual(payload.status, "unknown");
  assert.strictEqual(payload.bookingId, "19339999");
  assert.strictEqual(payload.duplicateUrl, undefined);
});
