import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

type ContentPageState = {
  status?: string;
  pageKind?: string;
  pageUrl?: string;
};

type ContentResponse = {
  error?: string;
  ok: boolean;
  pageState?: ContentPageState;
  source?: string;
};

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: ContentResponse) => void
) => boolean;

function collectContentPageState(options: {
  bodyText: string;
  pathname: string;
  search?: string;
  selectors?: string[];
}) {
  const contentScript = readFileSync(resolve("extensions/deliveree-capture/content.js"), "utf8");
  let listener: MessageListener | undefined;
  const selectorSet = new Set(options.selectors ?? []);
  const search = options.search ?? "";

  const context = {
    chrome: {
      runtime: {
        id: "test-extension-id",
        getURL(path: string) {
          return path;
        },
        onMessage: {
          addListener(callback: MessageListener) {
            listener = callback;
            return undefined;
          }
        },
        sendMessage() {
          return undefined;
        }
      }
    },
    document: {
      body: {
        innerText: options.bodyText,
        textContent: options.bodyText
      },
      querySelector(selector: string) {
        return selectorSet.has(selector)
          ? {
              innerText: options.bodyText,
              textContent: options.bodyText
            }
          : undefined;
      },
      querySelectorAll() {
        return [];
      }
    },
    MutationObserver: class {
      observe() {
        return undefined;
      }
    },
    window: {
      URLSearchParams,
      addEventListener() {
        return undefined;
      },
      clearInterval() {
        return undefined;
      },
      clearTimeout() {
        return undefined;
      },
      location: {
        href: `https://webapp.deliveree.com${options.pathname}${search}`,
        pathname: options.pathname,
        search
      },
      setInterval() {
        return 1;
      },
      setTimeout() {
        return 1;
      }
    }
  };

  runInNewContext(contentScript, context);

  assert.ok(listener, "content script should register a message listener");

  let response: ContentResponse | undefined;
  const handled = listener({
    type: "DELIVEREE_COLLECT_PAGE_STATE"
  }, {}, (value) => {
    response = value;
  });

  assert.strictEqual(handled, true);
  assert.ok(response, "content script should respond with page state");
  return response;
}

test("Deliveree extension content script classifies booking creation page as draft page", () => {
  const response = collectContentPageState({
    bodyText: "Layanan Utama Pesanan Terbaru Pesan Kendaraan",
    pathname: "/bookings/new",
    selectors: ["#front-page-wrapper, #front-page-card-pesan-kendaraan"]
  });

  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.source, "draft_page_detected");
  assert.strictEqual(response.pageState?.pageKind, "draft_page");
});

test("Deliveree extension content script still classifies root page as front page", () => {
  const response = collectContentPageState({
    bodyText: "Layanan Utama Pesanan Terbaru Pesan Kendaraan",
    pathname: "/",
    selectors: ["#front-page-wrapper, #front-page-card-pesan-kendaraan"]
  });

  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.source, "front_page_detected");
  assert.strictEqual(response.pageState?.pageKind, "front_page");
});

test("Deliveree extension content script does not treat failed driver modal as driver assigned", () => {
  const response = collectContentPageState({
    bodyText: [
      "#MOCK-7777",
      "Tidak bisa menemukan driver",
      "Maaf, saat ini seluruh pengemudi kami sedang sibuk melayani pemesanan lain.",
      "Silakan coba memesan kembali.",
      "Jenis Layanan Pickup (1 Ton)",
      "Coba Pesan Kembali"
    ].join("\n"),
    pathname: "/bookings/7777"
  });

  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.pageState?.status, "no_driver_found");
});

test("Deliveree extension content script treats driver evidence as assigned even if old failed text remains", () => {
  const response = collectContentPageState({
    bodyText: [
      "#MOCK-7777",
      "Tidak bisa menemukan driver",
      "Driver Ditemukan!",
      "Pengemudi: Budi Santoso",
      "Kendaraan: Pickup Mitsubishi L300",
      "Plat Nomor: B 9876 CKY",
      "Jenis Layanan Pickup (1 Ton)"
    ].join("\n"),
    pathname: "/bookings/7777"
  });

  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.pageState?.status, "driver_assigned");
});
