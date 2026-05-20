import type { ButtonInteraction } from "discord.js";
import { env } from "../config/env.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import { parseSignedDelivereeButtonId } from "../security/signedButton.js";
import { createDelivereeCaseStore, createDelivereeWebClient } from "../deliveree/liveRuntime.js";
import { getDelivereeRuntimeMode } from "../deliveree/runtimeControl.js";

function isDelivereeButton(customId: string) {
  return customId.startsWith("deliv:");
}

export async function handleDelivereeButtonInteraction(interaction: ButtonInteraction) {
  if (!isDelivereeButton(interaction.customId)) {
    return false;
  }

  const deniedReason = getDelivereeAccessDeniedReason(interaction);

  if (deniedReason) {
    await interaction.reply({
      content: deniedReason,
      flags: ["Ephemeral"]
    });
    return true;
  }

  const staticTurnOffMatch = /^deliv:turn_off_auto_retry:([^:]+)$/.exec(interaction.customId);
  const parsed = staticTurnOffMatch
    ? {
        action: "turn_off_auto_retry" as const,
        caseId: staticTurnOffMatch[1],
        expiresAt: Math.floor((Date.now() + 60_000) / 1000),
        nonce: `turn-off-auto-retry-${Date.now()}`
      }
    : parseSignedDelivereeButtonId(
        interaction.customId,
        env.DELIVEREE_BUTTON_SIGNING_SECRET || "kyou-deliveree-local-extension-button-v1"
      );

  if (!parsed) {
    await interaction.reply({
      content: "Action Deliveree ditolak karena button invalid atau expired.",
      flags: ["Ephemeral"]
    });
    return true;
  }
  const store = createDelivereeCaseStore();
  const recoveryCase = await store.getCase(parsed.caseId);

  if (!recoveryCase || recoveryCase.closedAt) {
    await interaction.reply({
      content: "Recovery case tidak ditemukan atau sudah ditutup.",
      flags: ["Ephemeral"]
    });
    return true;
  }

  if (await store.hasActionNonce(parsed.caseId, parsed.nonce)) {
    await interaction.reply({
      content: "Action Deliveree ditolak karena button ini sudah pernah dipakai.",
      flags: ["Ephemeral"]
    });
    return true;
  }

  if (parsed.action === "close") {
    await store.closeCase(parsed.caseId, interaction.user.id, parsed.nonce);
    await interaction.reply({
      content: `Recovery case Deliveree #${recoveryCase.bookingId} ditutup.`,
      flags: ["Ephemeral"]
    });
    return true;
  }

  if (parsed.action === "manual_reorder") {
    await store.closeCase(
      parsed.caseId,
      interaction.user.id,
      parsed.nonce,
      "manual_reorder",
      "Staff sudah reorder manual di Deliveree."
    );
    await interaction.reply({
      content: `Recovery case Deliveree #${recoveryCase.bookingId} ditutup. Reorder manual sudah dilakukan.`,
      flags: ["Ephemeral"]
    });
    return true;
  }

  if (parsed.action === "ignore") {
    await store.silenceCase(parsed.caseId, interaction.user.id, "Staff memutuskan untuk abaikan case ini.", parsed.nonce);
    await interaction.reply({
      content: `Recovery case Deliveree #${recoveryCase.bookingId} diabaikan. Alert tidak akan muncul lagi.`,
      flags: ["Ephemeral"]
    });
    return true;
  }

  if (parsed.action === "need_followup") {
    await store.appendActionLog(parsed.caseId, {
      action: "need_followup",
      nonce: parsed.nonce,
      note: "Staff menandai case ini butuh follow up manual.",
      userId: interaction.user.id
    });
    await interaction.reply({
      content: `Recovery case Deliveree #${recoveryCase.bookingId} ditandai butuh follow up. Case tetap aktif.`,
      flags: ["Ephemeral"]
    });
    return true;
  }

  if (parsed.action === "turn_off_auto_retry") {
    await store.appendActionLog(parsed.caseId, {
      action: "turn_off_auto_retry",
      nonce: parsed.nonce,
      note: "Staff mematikan Auto Retry dari tombol Discord.",
      userId: interaction.user.id
    });
    await interaction.reply({
      content: `Auto Retry untuk Deliveree #${recoveryCase.bookingId} akan dimatikan saat extension ${recoveryCase.deviceId || "terkait"} tersambung ke local intake.`,
      flags: ["Ephemeral"]
    });
    return true;
  }

  await interaction.deferReply({
    flags: ["Ephemeral"]
  });

  const webClient = createDelivereeWebClient();

  if (parsed.action === "refresh") {
    const inspection = await webClient.inspectBooking(recoveryCase.url);
    await store.upsertObservation({
      bookingId: inspection.bookingId,
      screenshotPath: inspection.screenshotPath,
      status: inspection.classification.status,
      url: recoveryCase.url
    });
    await store.appendActionLog(parsed.caseId, {
      action: "refresh",
      afterStatus: inspection.classification.status,
      beforeStatus: recoveryCase.status,
      nonce: parsed.nonce,
      screenshotPath: inspection.screenshotPath,
      userId: interaction.user.id
    });

    await interaction.editReply([
      `Status Deliveree #${inspection.bookingId}: \`${inspection.classification.status}\``,
      inspection.classification.summary,
      `Screenshot lokal: \`${inspection.screenshotPath}\``
    ].join("\n"));
    return true;
  }

  if (getDelivereeRuntimeMode() !== "prepare_reorder") {
    await interaction.editReply("Prepare reorder masih dikunci. Set `DELIVEREE_ACTION_MODE=prepare_reorder` hanya jika workflow ini sudah disetujui untuk dipakai.");
    return true;
  }

  const result = await webClient.prepareReorderDraft(recoveryCase.url);
  await store.appendActionLog(parsed.caseId, {
    action: "prepare_reorder_blocked_before_click",
    afterStatus: result.inspection.classification.status,
    beforeStatus: recoveryCase.status,
    nonce: parsed.nonce,
    note: result.reason,
    screenshotPath: result.inspection.screenshotPath,
    userId: interaction.user.id
  });
  await interaction.editReply([
    "Prepare reorder berhenti sebelum klik action apa pun.",
    result.reason,
    `Status: \`${result.inspection.classification.status}\``,
    `Screenshot lokal: \`${result.inspection.screenshotPath}\``
  ].join("\n"));
  return true;
}


