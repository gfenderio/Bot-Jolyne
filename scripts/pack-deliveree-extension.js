import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(rootDir, "extensions", "deliveree-capture");
const targetDir = resolve(rootDir, "dist", "deliveree-capture-extension");

await rm(targetDir, {
  force: true,
  recursive: true
});
await mkdir(targetDir, {
  recursive: true
});
await cp(sourceDir, targetDir, {
  recursive: true
});

console.log(`Deliveree extension package ready: ${targetDir}`);
