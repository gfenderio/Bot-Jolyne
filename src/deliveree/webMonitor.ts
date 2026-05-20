import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";
import type { Client } from "discord.js";
import { env } from "../config/env.js";
import { createSignedDelivereeButtonId } from "../security/signedButton.js";
import { createDelivereeCaseStore, createDelivereeWebClient } from "./liveRuntime.js";
import { getDelivereeRuntimeMode, isDelivereePaused } from "./runtimeControl.js";
import type { DelivereeRecoveryCase } from "./caseStore.js";
import type { DelivereeWebInspection } from "./webClient.js";

function buildDelivereeEmbed(recoveryCase: DelivereeRecoveryCase, inspection: DelivereeWebInspection) {
  return new EmbedBuilder()
    .setColor(inspection.classification.status === "unknown" ? 0xf2c94c : 0x2f80ed)
    .setTitle(`Kyou Deliveree #${recoveryCase.bookingId}`)
    .setDescription(inspection.classification.summary)
    .addFields(
      {
        name: "Status",
        value: `\`${inspection.classification.status}\``,
        inline: true
      },
      {
        name: "Mode",
        value: `\`${getDelivereeRuntimeMode()}\``,
        inline: true
      },
      {
        name: "Action Aman",
        value: inspection.classification.recommendedAction,
        inline: false
      },
      {
        name: "Safety",
        value: inspection.classification.finalActionVisible
          ? "Final action terlihat. Sistem tidak akan klik tombol final."
          : "Tidak ada final action yang ditandai classifier.",
        inline: false
      },
      {
        name: "URL",
        value: recoveryCase.url,
        inline: false
      }
    )
    .setFooter({
      text: `Screenshot tersimpan lokal: ${inspection.screenshotPath}`
    })
    .setTimestamp(new Date(inspection.inspectedAt));
}

function buildDelivereeButtons(caseId: string) {
  if (!env.DELIVEREE_BUTTON_SIGNING_SECRET) {
    return [];
  }

  const components = [
    new ButtonBuilder()
      .setCustomId(createSignedDelivereeButtonId({
        action: "refresh",
        caseId,
        secret: env.DELIVEREE_BUTTON_SIGNING_SECRET
      }))
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(createSignedDelivereeButtonId({
        action: "close",
        caseId,
        secret: env.DELIVEREE_BUTTON_SIGNING_SECRET
      }))
      .setLabel("Close Case")
      .setStyle(ButtonStyle.Secondary)
  ];

  if (getDelivereeRuntimeMode() === "prepare_reorder") {
    components.splice(
      1,
      0,
      new ButtonBuilder()
        .setCustomId(createSignedDelivereeButtonId({
          action: "prepare_reorder",
          caseId,
          secret: env.DELIVEREE_BUTTON_SIGNING_SECRET
        }))
        .setLabel("Prepare Reorder")
        .setStyle(ButtonStyle.Success)
    );
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(...components)
  ];
}

async function sendObservation(client: Client<true>, recoveryCase: DelivereeRecoveryCase, inspection: DelivereeWebInspection) {
  const channel = await client.channels.fetch(env.DELIVEREE_ALERT_CHANNEL_ID);

  if (!channel?.isTextBased() || !("send" in channel)) {
    console.error(`Deliveree monitor: channel ${env.DELIVEREE_ALERT_CHANNEL_ID} tidak bisa dikirimi pesan.`);
    return;
  }

  const message = await channel.send({
    components: buildDelivereeButtons(recoveryCase.caseId),
    embeds: [buildDelivereeEmbed(recoveryCase, inspection)]
  });

  await createDelivereeCaseStore().setAlertMessage(recoveryCase.caseId, channel.id, message.id);
}

export async function runDelivereeWebMonitorOnce(client: Client<true>) {
  if (!env.DELIVEREE_WEB_AUTOMATION_APPROVED) {
    console.warn("Deliveree monitor dilewati karena compliance gate belum approve live web automation.");
    return;
  }

  if (isDelivereePaused()) {
    console.warn("Deliveree monitor dilewati karena mode paused.");
    return;
  }

  if (env.DELIVEREE_WATCH_URLS.length === 0) {
    return;
  }

  const webClient = createDelivereeWebClient();
  const store = createDelivereeCaseStore();

  for (const url of env.DELIVEREE_WATCH_URLS) {
    try {
      const inspection = await webClient.inspectBooking(url);
      const { changed, recoveryCase } = await store.upsertObservation({
        bookingId: inspection.bookingId,
        screenshotPath: inspection.screenshotPath,
        status: inspection.classification.status,
        url
      });

      if (changed || inspection.classification.status === "unknown") {
        await sendObservation(client, recoveryCase, inspection);
      }
    } catch (error) {
      console.error(`Deliveree monitor: gagal inspect ${url}.`, error);
    }
  }
}

export function startDelivereeWebMonitor(client: Client<true>) {
  if (!env.DELIVEREE_WEB_AUTOMATION_APPROVED) {
    console.log("Deliveree web monitor tidak aktif karena DELIVEREE_WEB_AUTOMATION_APPROVED belum true.");
    return () => undefined;
  }

  if (env.DELIVEREE_WATCH_URLS.length === 0) {
    console.log("Deliveree web monitor tidak aktif karena DELIVEREE_WATCH_URLS kosong.");
    return () => undefined;
  }

  let isRunning = false;

  const run = async () => {
    if (isRunning) {
      return;
    }

    isRunning = true;

    try {
      await runDelivereeWebMonitorOnce(client);
    } finally {
      isRunning = false;
    }
  };

  void run();
  const interval = setInterval(() => {
    void run();
  }, env.DELIVEREE_MONITOR_INTERVAL_SECONDS * 1000);

  console.log(
    `Deliveree web monitor aktif untuk ${env.DELIVEREE_WATCH_URLS.length} URL setiap ${env.DELIVEREE_MONITOR_INTERVAL_SECONDS} detik.`
  );

  return () => {
    clearInterval(interval);
  };
}



