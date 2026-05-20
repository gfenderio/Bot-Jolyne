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
  homepageOrder?: {
    address: string;
    bookingId: string;
    subtitle: string;
    timeLeft: string;
  };
}) {
  const contentScript = readFileSync(resolve("extensions/deliveree-capture/content.js"), "utf8");
  let listener: MessageListener | undefined;
  const selectorSet = new Set(options.selectors ?? []);
  const search = options.search ?? "";
  const homepageOrder = options.homepageOrder;
  const homepageOrderElement = homepageOrder
    ? {
        innerText: `Pemesanan #${homepageOrder.bookingId} ${homepageOrder.address}`,
        textContent: `Pemesanan #${homepageOrder.bookingId} ${homepageOrder.address}`,
        querySelector(selector: string) {
          if (selector === "b") {
            return {
              innerText: `Pemesanan #${homepageOrder.bookingId}`,
              textContent: `Pemesanan #${homepageOrder.bookingId}`
            };
          }
          if (selector === "span") {
            return {
              innerText: homepageOrder.address,
              textContent: homepageOrder.address
            };
          }
          return undefined;
        },
        closest(selector: string) {
          if (selector !== ".Dropdown-Menu-Item") return undefined;
          return {
            innerText: `Pemesanan #${homepageOrder.bookingId} ${homepageOrder.address} ${homepageOrder.timeLeft} Time Left`,
            textContent: `Pemesanan #${homepageOrder.bookingId} ${homepageOrder.address} ${homepageOrder.timeLeft} Time Left`,
            querySelector(childSelector: string) {
              if (childSelector === ".Dropdown-Devina-Time b") {
                return {
                  innerText: homepageOrder.timeLeft,
                  textContent: homepageOrder.timeLeft
                };
              }
              return undefined;
            }
          };
        }
      }
    : undefined;

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
        if (selector === ".TitleSubtitle-subtitle" && homepageOrder) {
          return {
            innerText: homepageOrder.subtitle,
            textContent: homepageOrder.subtitle
          };
        }

        return selectorSet.has(selector)
          ? {
              innerText: options.bodyText,
              textContent: options.bodyText
            }
          : undefined;
      },
      querySelectorAll(selector: string) {
        if (selector === ".Dropdown-Devina-Group" && homepageOrderElement) {
          return [homepageOrderElement];
        }
        return [];
      }
    },
    MutationObserver: class {
      observe() {
        return undefined;
      }
    },
    window: {
      URL,
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

test("Deliveree extension content script treats plain booking detail URL as active order", () => {
  const response = collectContentPageState({
    bodyText: [
      "#19430136",
      "Pickup (1 Ton)",
      "Total Jarak 14.8 km",
      "Tujuan 2",
      "No. Job JB-19430136"
    ].join("\n"),
    pathname: "/bookings/19430136"
  });

  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.source, "booking_payload");
  assert.strictEqual(response.pageState?.status, "active_booking");
});


test("Deliveree extension content script detects active order from homepage top nav", () => {
  const response = collectContentPageState({
    bodyText: "Pemesanan Baru Atur Pemesanan Mencari pengemudi Pemesanan #19430136",
    homepageOrder: {
      address: "KyouLab, Jalan Mangga Timur II, Kota Bekasi",
      bookingId: "19430136",
      subtitle: "Mencari pengemudi...",
      timeLeft: "00:05"
    },
    pathname: "/"
  });

  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.source, "booking_payload");
  assert.strictEqual(response.pageState?.status, "searching_driver");
  assert.strictEqual(response.pageState?.pageUrl, "https://webapp.deliveree.com/bookings/19430136");
});
