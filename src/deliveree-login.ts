import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { env } from "./config/env.js";

if (!env.DELIVEREE_WEB_AUTOMATION_APPROVED) {
  console.error(
    "Login Playwright Deliveree dikunci. Set DELIVEREE_WEB_AUTOMATION_APPROVED=true hanya setelah ada izin/approval yang jelas untuk akses otomatis Deliveree."
  );
  process.exit(1);
}

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

