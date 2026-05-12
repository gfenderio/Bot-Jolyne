import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const sourceDir = resolve("extensions/kyou-item-scanner-opener");
const targetDir = resolve("dist/kyou-item-scanner-opener");

await rm(targetDir, {
  force: true,
  recursive: true
});
await mkdir(join(targetDir, ".."), {
  recursive: true
});
await cp(sourceDir, targetDir, {
  recursive: true
});

console.log(`Kyou item scanner extension package ready: ${targetDir}`);
