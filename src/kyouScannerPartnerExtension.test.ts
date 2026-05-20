import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadExtensionHelpers(
  currentHref: string,
  initialStorage: Record<string, unknown> = {},
  options: {
    noChrome?: boolean;
    nextDataText?: string;
    sessionItems?: Record<string, string>;
  } = {}
) {
  const contentScript = readFileSync("extensions/kyou-item-scanner-opener/content.js", "utf8");
  const storage: Record<string, unknown> = {
    ...initialStorage
  };
  const sessionItems: Record<string, string> = {
    ...options.sessionItems
  };
  const appendedToasts: string[] = [];
  const replacedUrls: string[] = [];
  const chromeShim = {
    runtime: {
      id: "test-extension-id",
      getURL(path: string) {
        return path;
      }
    },
    storage: {
      local: {
        get(keys: string | string[] | Record<string, unknown>, callback: (value: Record<string, unknown>) => void) {
          if (typeof keys === "string") {
            callback({
              [keys]: storage[keys]
            });
            return;
          }

          if (Array.isArray(keys)) {
            callback(Object.fromEntries(keys.map((key) => [
              key,
              storage[key]
            ])));
            return;
          }

          callback({
            ...keys,
            ...storage
          });
        },
        remove(keys: string | string[], callback?: () => void) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storage[key];
          }
          callback?.();
        },
        set(value: Record<string, unknown>, callback?: () => void) {
          Object.assign(storage, value);
          callback?.();
        }
      },
      onChanged: {
        addListener() {
          // Test shim.
        }
      }
    }
  };
  const context = {
    URL,
    ...(options.noChrome ? {} : {
      chrome: chromeShim
    }),
    document: {
      querySelector(selector: string) {
        if (selector === "#__NEXT_DATA__" && options.nextDataText) {
          return {
            textContent: options.nextDataText
          };
        }

        return undefined;
      },
      createElement() {
        return {
          id: "",
          removed: false,
          style: {},
          textContent: "",
          remove() {
            this.removed = true;
          }
        };
      },
      body: {
        appendChild(node: { textContent: string }) {
          appendedToasts.push(node.textContent);
        }
      },
      documentElement: {
        appendChild(node: { textContent: string }) {
          appendedToasts.push(node.textContent);
        }
      }
    },
    window: {
      addEventListener() {
      // Test shim.
      },
      clearInterval() {
        // Test shim.
      },
      clearTimeout() {
        // Test shim.
      },
      location: {
        href: currentHref,
        replace(url: string) {
          replacedUrls.push(url);
          this.href = url;
        }
      },
      requestAnimationFrame(callback: () => void) {
        callback();
      },
      setTimeout(callback: () => void) {
        callback();
        return 1;
      },
      setInterval() {
        return 1;
      }
    },
    sessionStorage: {
      getItem(key: string) {
        return sessionItems[key] ?? null;
      },
      removeItem(key: string) {
        delete sessionItems[key];
      },
      setItem(key: string, value: string) {
        sessionItems[key] = value;
      }
    }
  };

  vm.runInNewContext(
    `${contentScript}; globalThis.__helpers = { buildSearchUrl, getScanDestination, getToastMessage, isPendingToastTargetPage };`,
    context
  );

  const helpers = (context as typeof context & {
    __helpers: {
      buildSearchUrl: (code: string) => string;
      getScanDestination: (code: string) => "item" | "search";
      getToastMessage: (scan?: { code?: string; itemId?: string; result?: string; status: string }) => string;
      isPendingToastTargetPage: (pendingToast: unknown, currentHref: string) => boolean;
    };
  }).__helpers;

  return {
    ...helpers,
    appendedToasts,
    replacedUrls,
    sessionItems,
    storage
  };
}

test("Kyou Scanner Partner opens 5-6 digit scans as item pages", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/");

  assert.equal(helpers.getScanDestination("12345"), "item");
  assert.equal(helpers.getScanDestination("123343"), "item");
});

test("Kyou Scanner Partner searches 7+ digit scans instead of opening risky item pages", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/");

  assert.equal(helpers.getScanDestination("1321321"), "search");
  assert.equal(
    helpers.buildSearchUrl("1321321"),
    "https://kyou.id/search?q=1321321&page=1%2C40&sort=newest"
  );
});

test("Kyou Scanner Partner toast target matches item pages with slug", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/");

  assert.equal(
    helpers.isPendingToastTargetPage({
      itemId: "123343",
      status: "opened",
      url: "https://kyou.id/items/123343/"
    }, "https://kyou.id/items/123343/219402"),
    true
  );
});

test("Kyou Scanner Partner toast target rejects a different item page", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/");

  assert.equal(
    helpers.isPendingToastTargetPage({
      itemId: "123343",
      status: "opened",
      url: "https://kyou.id/items/123343/"
    }, "https://kyou.id/items/999999/other-item"),
    false
  );
});

test("Kyou Scanner Partner renders a pending toast on the matching item page", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/items/123343/219402", {
    pendingToast: {
      code: "123343",
      itemId: "123343",
      status: "opened",
      url: "https://kyou.id/items/123343/"
    }
  });

  assert.deepEqual(helpers.appendedToasts, [
    "Item 123343 dibuka"
  ]);
  assert.equal(helpers.storage.pendingToast, undefined);
});

test("Kyou Scanner Partner renders pending toast from session backup", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/items/123343/", {}, {
    sessionItems: {
      kyouScannerPartnerPendingToast: JSON.stringify({
        code: "123343",
        itemId: "123343",
        queuedAt: "2026-05-20T00:00:00.000Z",
        status: "opened",
        url: "https://kyou.id/items/123343/"
      })
    }
  });

  assert.deepEqual(helpers.appendedToasts, [
    "Item 123343 dibuka"
  ]);
  assert.equal(helpers.sessionItems.kyouScannerPartnerPendingToast, undefined);
});

test("Kyou Scanner Partner does not throw when chrome.storage is unavailable", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/items/123343/", {}, {
    noChrome: true,
    sessionItems: {
      kyouScannerPartnerPendingToast: JSON.stringify({
        code: "123343",
        itemId: "123343",
        queuedAt: "2026-05-20T00:00:00.000Z",
        status: "opened",
        url: "https://kyou.id/items/123343/"
      })
    }
  });

  assert.deepEqual(helpers.appendedToasts, [
    "Item 123343 dibuka"
  ]);
});

test("Kyou Scanner Partner clears corrupt pending toast from session backup", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/items/123343/", {}, {
    sessionItems: {
      kyouScannerPartnerPendingToast: JSON.stringify({
        queuedAt: "2026-05-20T00:00:00.000Z",
        url: "https://kyou.id/items/123343/"
      })
    }
  });

  assert.deepEqual(helpers.appendedToasts, []);
  assert.equal(helpers.sessionItems.kyouScannerPartnerPendingToast, undefined);
});

test("Kyou Scanner Partner clears corrupt pending toast from extension storage", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/items/123343/", {
    pendingToast: {
      queuedAt: "2026-05-20T00:00:00.000Z",
      url: "https://kyou.id/items/123343/"
    }
  });

  assert.deepEqual(helpers.appendedToasts, []);
  assert.equal(helpers.storage.pendingToast, undefined);
});

test("Kyou Scanner Partner toast message has safe fallback for invalid data", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/");

  assert.equal(helpers.getToastMessage(), "Scanner Partner siap");
  assert.equal(
    helpers.isPendingToastTargetPage(undefined, "https://kyou.id/items/123343/"),
    false
  );
});

test("Kyou Scanner Partner has toast copy for all scan statuses", () => {
  const helpers = loadExtensionHelpers("https://kyou.id/");

  assert.equal(
    helpers.getToastMessage({
      code: "1321321",
      status: "not_found"
    }),
    "Kode tidak ditemukan: 1321321"
  );
  assert.equal(
    helpers.getToastMessage({
      code: "123343",
      itemId: "123343",
      status: "opened"
    }),
    "Item 123343 dibuka"
  );
  assert.equal(
    helpers.getToastMessage({
      code: "4571623516248",
      itemId: "150052",
      status: "copied_and_opened"
    }),
    "Kyou ID 150052 disalin, item dibuka"
  );
  assert.equal(
    helpers.getToastMessage({
      code: "4571623516248",
      itemId: "150052",
      status: "copy_failed_opened"
    }),
    "Copy gagal, item dibuka: 150052"
  );
  assert.equal(
    helpers.getToastMessage({
      code: "4571623516248",
      status: "searching"
    }),
    "Mencari kode: 4571623516248"
  );
});

test("Kyou Scanner Partner recovers Kyou item pages that return catalog 404", async () => {
  const helpers = loadExtensionHelpers("https://kyou.id/items/1321321", {}, {
    nextDataText: JSON.stringify({
      page: "/items/[id]",
      props: {
        pageProps: {
          data: null,
          itemError: {
            errorCode: "catalog-404",
            errorMessage: "Item not found"
          }
        }
      }
    })
  });

  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(helpers.replacedUrls.length, 1);
  assert.equal(
    helpers.replacedUrls[0],
    "https://kyou.id/search?q=1321321&page=1%2C40&sort=newest"
  );
  assert.equal((helpers.storage.lastScan as { status: string }).status, "not_found");
  assert.equal((helpers.storage.pendingToast as { status: string }).status, "not_found");
});
