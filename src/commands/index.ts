import type { SlashCommand } from "../types/command.js";
import { command as birthday } from "./birthday.js";
import { command as birthdayNow, testCommand as birthdayNowTest } from "./birthday-now.js";
import { command as mockOrder } from "./mock-order.js";
import { command as ping } from "./ping.js";
import { command as server } from "./server.js";
import { command as trackTest } from "./track-test.js";

export const commands = new Map<string, SlashCommand>();

for (const command of [ping, server, birthday, birthdayNow, birthdayNowTest, trackTest, mockOrder]) {
  commands.set(command.data.name, command);
}

export const commandData = [...commands.values()].map((command) => command.data.toJSON());
