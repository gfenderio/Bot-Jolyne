import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { env } from "./config/env.js";

const loginUrl = env.DELIVEREE_WATCH_URLS[0] ?? "https://webapp.deliveree.com/";

const context = await chromium.launchPersistentContext(env.DELIVEREE_PLAYWRIGHT_PROFILE_DIR, {
  headless: false,
  viewport: {
    height: 900,
    width: 1440
  }
});

try {
  const page = await context.newPage();
  await page.goto(loginUrl, {
    waitUntil: "domcontentloaded"
  });

  console.log("Login Deliveree secara manual di browser yang terbuka.");
  console.log("Jangan ketik password Deliveree ke chat, repo, atau file konfigurasi.");

  const rl = createInterface({
    input,
    output
  });

  await rl.question("Tekan Enter di terminal ini setelah login selesai...");
  rl.close();
} finally {
  await context.close();
}

