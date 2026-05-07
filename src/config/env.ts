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
  BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID: optionalString.default("687632832125992979")
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
