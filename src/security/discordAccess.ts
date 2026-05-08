import { env } from "../config/env.js";

type DiscordInteractionLike = {
  channelId: string | null;
  guildId: string | null;
  user: {
    id: string;
  };
};

export function getDelivereeAllowedChannelIds() {
  return env.DELIVEREE_ALLOWED_CHANNEL_IDS?.length
    ? env.DELIVEREE_ALLOWED_CHANNEL_IDS
    : [env.DELIVEREE_ALERT_CHANNEL_ID];
}

export function isDelivereeOwnerUser(userId: string) {
  return env.DELIVEREE_OWNER_USER_IDS.includes(userId);
}

export function isDelivereeGuildAllowed(guildId: string | null) {
  const allowedGuildId = env.DELIVEREE_ALLOWED_GUILD_ID ?? env.DISCORD_GUILD_ID;
  return !allowedGuildId || guildId === allowedGuildId;
}

export function isDelivereeChannelAllowed(channelId: string | null) {
  const allowedChannelIds = getDelivereeAllowedChannelIds();
  return Boolean(channelId && allowedChannelIds.includes(channelId));
}

export function getDelivereeAccessDeniedReason(
  interaction: DiscordInteractionLike,
  options: {
    requireAllowedChannel?: boolean;
    requireOwner?: boolean;
  } = {}
) {
  const requireAllowedChannel = options.requireAllowedChannel ?? true;
  const requireOwner = options.requireOwner ?? true;

  if (requireOwner && !isDelivereeOwnerUser(interaction.user.id)) {
    return "Action Deliveree hanya bisa dijalankan oleh owner bot.";
  }

  if (!isDelivereeGuildAllowed(interaction.guildId)) {
    return "Action Deliveree ditolak karena server Discord tidak masuk allowlist.";
  }

  if (requireAllowedChannel && !isDelivereeChannelAllowed(interaction.channelId)) {
    return "Action Deliveree hanya bisa dijalankan di channel Deliveree yang diizinkan.";
  }

  return undefined;
}

