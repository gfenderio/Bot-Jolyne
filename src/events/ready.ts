import type { Client } from "discord.js";

export function handleReady(client: Client<true>) {
  console.log(`Login sebagai ${client.user.tag}`);
}
