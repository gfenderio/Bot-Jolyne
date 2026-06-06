import type { SlashCommand } from "../types/command.js";
import { command as birthday } from "./birthday.js";
import { command as birthdayNow } from "./birthday-now.js";
import { command as delivereeCase } from "./deliveree-case.js";
import { command as delivereeCases } from "./deliveree-cases.js";
import { command as delivereeStatus } from "./deliveree-status.js";
import { command as delivereeExtensionHealth } from "./deliveree-extension-health.js";
import { command as ping } from "./ping.js";
import { command as server } from "./server.js";
import { command as whoami } from "./whoami.js";
import { command as task } from "./task.js";

export const commands = new Map<string, SlashCommand>();

for (const command of [
  ping,
  server,
  birthday,
  birthdayNow,
  whoami,
  delivereeCase,
  delivereeCases,
  delivereeStatus,
  delivereeExtensionHealth,
  task
]) {
  commands.set(command.data.name, command);
}

export const commandData = [...commands.values()].map((command) => command.data.toJSON());
