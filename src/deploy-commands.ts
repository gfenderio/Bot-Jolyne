import { registerGuildSlashCommands } from "./services/slash-commands.js";

try {
  await registerGuildSlashCommands();
} catch (error) {
  console.error("Gagal deploy slash command.", error);
  process.exitCode = 1;
}
