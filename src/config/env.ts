import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  },
  z.string().optional()
);

const optionalUrl = optionalString.pipe(z.string().url().optional());

const optionalDatabaseId = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed === "" ? 2 : trimmed;
    }

    return value === undefined ? 2 : value;
  },
  z.coerce.number().int().positive()
);

const pollIntervalSeconds = z.preprocess(
  (value) => {
    if (value === undefined) {
      return 10;
    }

    if (typeof value === "string" && value.trim() === "") {
      return 10;
    }

    return value;
  },
  z.coerce.number().int().positive()
);

const optionalStringList = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  },
  z.array(z.string()).optional()
);

const delivereeActionMode = z.enum(["paused", "prepare_reorder", "readonly"]).default("readonly");

const envSchema = z.object({
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,
  DISCORD_WEBHOOK_URL: optionalUrl,
  POLL_INTERVAL_SECONDS: pollIntervalSeconds,
  METABASE_URL: optionalUrl,
  METABASE_EMAIL: optionalString.pipe(z.string().email().optional()),
  METABASE_PASSWORD: optionalString,
  METABASE_DATABASE_ID: optionalDatabaseId,
  BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID: optionalString.default("687632832125992979"),
  DELIVEREE_ACTION_MODE: delivereeActionMode,
  DELIVEREE_ALERT_CHANNEL_ID: optionalString.default("1501899831268868106"),
  DELIVEREE_ALLOWED_CHANNEL_IDS: optionalStringList,
  DELIVEREE_ALLOWED_GUILD_ID: optionalString,
  DELIVEREE_BUTTON_SIGNING_SECRET: optionalString,
  DELIVEREE_CASE_STORE_PATH: optionalString.default("data/deliveree-cases.json"),
  DELIVEREE_MONITOR_INTERVAL_SECONDS: pollIntervalSeconds.default(60),
  DELIVEREE_OWNER_USER_IDS: optionalStringList.default(["419213146209779713"]),
  DELIVEREE_PLAYWRIGHT_PROFILE_DIR: optionalString.default("data/deliveree-playwright-profile"),
  DELIVEREE_SCREENSHOT_DIR: optionalString.default("data/deliveree-screenshots"),
  DELIVEREE_WATCH_URLS: optionalStringList.default([])
});

export const env = envSchema.parse(process.env);

const requiredDiscordBotEnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1)
});

export function requireDiscordBotEnv() {
  const result = requiredDiscordBotEnvSchema.safeParse(env);

  if (!result.success) {
    throw new Error("DISCORD_TOKEN, DISCORD_CLIENT_ID, dan DISCORD_GUILD_ID wajib diisi untuk menjalankan Discord bot.");
  }

  return result.data;
}
