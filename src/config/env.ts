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

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  METABASE_URL: optionalString.pipe(z.string().url().optional()),
  METABASE_EMAIL: optionalString.pipe(z.string().email().optional()),
  METABASE_PASSWORD: optionalString,
  METABASE_DATABASE_ID: optionalDatabaseId,
  BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID: optionalString.default("687632832125992979")
});

export const env = envSchema.parse(process.env);
