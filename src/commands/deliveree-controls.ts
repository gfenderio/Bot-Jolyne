import type { ButtonInteraction } from "discord.js";
import { env } from "../config/env.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import { delivereeButtonReplayGuard } from "../security/buttonReplayGuard.js";
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

  if (!env.DELIVEREE_BUTTON_SIGNING_SECRET) {
    await interaction.reply({
      content: "Deliveree button signing secret belum dikonfigurasi.",
      flags: ["Ephemeral"]
    });
    return true;
  }

  const deniedReason = getDelivereeAccessDeniedReason(interaction);

  if (deniedReason) {
    await interaction.reply({
      content: deniedReason,
      flags: ["Ephemeral"]
    });
    return true;
  }

  const parsed = parseSignedDelivereeButtonId(interaction.customId, env.DELIVEREE_BUTTON_SIGNING_SECRET);

  if (!parsed || !delivereeButtonReplayGuard.consume(parsed)) {
    await interaction.reply({
      content: "Action Deliveree ditolak karena button invalid, expired, atau sudah pernah dipakai.",
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
    await interaction.editReply("Prepare reorder masih dikunci. Set `DELIVEREE_ACTION_MODE=prepare_reorder` setelah read-only monitor terbukti aman.");
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
