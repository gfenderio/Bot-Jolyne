import type { Client } from "discord.js";

/**
 * Penanda build. NAIKKAN tiap kali ada perubahan yang perlu dipastikan benar-
 * benar sampai ke server — Coolify tidak punya CI/CD, jadi satu-satunya cara
 * membuktikan "container ini menjalankan kode terbaru" adalah membacanya di log.
 */
export const BUILD_MARKER = "2026-07-11 · pick-triage per-order + item id + foto";

export function handleReady(client: Client<true>) {
  console.log(`Login sebagai ${client.user.tag}`);
  console.log(`[build] ${BUILD_MARKER}`);
}
