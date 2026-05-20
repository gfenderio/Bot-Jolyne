import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(__dirname, "..", "extensions", "deliveree-capture", "icons", "scanner-partner.svg");
const iconsDir = resolve(__dirname, "..", "extensions", "deliveree-capture", "icons");

const svgContent = readFileSync(svgPath, "utf-8");

async function generate() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Set content to our SVG
  await page.setContent(`
    <html>
      <head>
        <style>
          body {
            margin: 0;
            padding: 0;
            overflow: hidden;
            background: transparent;
          }
          svg {
            width: 100vw;
            height: 100vh;
            display: block;
          }
        </style>
      </head>
      <body>
        ${svgContent}
      </body>
    </html>
  `);

  const sizes = [16, 32, 48, 128];
  
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    const outputPath = resolve(iconsDir, `scanner-partner-${size}.png`);
    await page.screenshot({
      path: outputPath,
      omitBackground: true,
      type: "png"
    });
    console.log(`Generated icon: scanner-partner-${size}.png`);
  }

  await browser.close();
}

generate().catch(console.error);
