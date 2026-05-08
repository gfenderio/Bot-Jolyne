import type { SlashCommand } from "../types/command.js";
import { command as birthday } from "./birthday.js";
import { command as birthdayNow, testCommand as birthdayNowTest } from "./birthday-now.js";
import { command as delivereeCase } from "./deliveree-case.js";
import { command as delivereeExtensionHealth } from "./deliveree-extension-health.js";
import { command as delivereePause } from "./deliveree-pause.js";
import { command as delivereePrepareReorder } from "./deliveree-prepare-reorder.js";
import { command as delivereeResume } from "./deliveree-resume.js";
import { command as delivereeSilence } from "./deliveree-silence.js";
import { command as delivereeStatus } from "./deliveree-status.js";
import { command as mockOrder } from "./mock-order.js";
import { command as ping } from "./ping.js";
import { command as server } from "./server.js";
import { command as trackTest } from "./track-test.js";
import { command as whoami } from "./whoami.js";

export const commands = new Map<string, SlashCommand>();

for (const command of [
  ping,
  server,
  birthday,
  birthdayNow,
  birthdayNowTest,
  trackTest,
  mockOrder,
  whoami,
  delivereeCase,
  delivereeExtensionHealth,
  delivereeStatus,
  delivereePause,
  delivereeResume,
  delivereePrepareReorder,
  delivereeSilence
]) {
  commands.set(command.data.name, command);
}

export const commandData = [...commands.values()].map((command) => command.data.toJSON());
