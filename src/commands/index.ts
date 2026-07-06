import type { SlashCommand } from "../types/command.js";
import { command as birthday } from "./birthday.js";
import { command as birthdayNow } from "./birthday-now.js";
import { command as ping } from "./ping.js";
import { command as server } from "./server.js";
import { command as whoami } from "./whoami.js";
import { command as task } from "./task.js";
import { command as opname } from "./opname.js";
import { command as baito } from "./baito.js";
import { command as oripaLive } from "./oripa-live.js";
import { command as oripaLiveRecap } from "./oripa-live-recap.js";

export const commands = new Map<string, SlashCommand>();

for (const command of [
  ping,
  server,
  birthday,
  birthdayNow,
  whoami,
  task,
  opname,
  baito,
  oripaLive,
  oripaLiveRecap
]) {
  commands.set(command.data.name, command);
}

export const commandData = [...commands.values()].map((command) => command.data.toJSON());
