import type { ButtonInteraction } from "discord.js";
import { buildMockOrderMessage } from "../deliveree/mockOrderEmbed.js";
import { createReplacementMockOrder } from "../deliveree/mockOrderGenerator.js";
import { getNextMockDelivereeTrackingResult, untrackMockDelivereeBookingId } from "../deliveree/mockRuntime.js";
import type { CreatedMockOrder } from "../deliveree/mockOrderGenerator.js";
import type { MockOrderDecision, MockOrderViewState } from "../deliveree/mockOrderEmbed.js";

type MockOrderControlAction = "cancel" | "refresh" | "reorder";

type ParsedMockOrderControlId = {
  action: MockOrderControlAction;
  bookingId: string;
};

export function parseMockOrderControlId(customId: string): ParsedMockOrderControlId | undefined {
  const [scope, action, ...bookingIdParts] = customId.split(":");

  if (scope !== "mock-order" || !bookingIdParts.length) {
    return undefined;
  }

  if (action !== "cancel" && action !== "refresh" && action !== "reorder") {
    return undefined;
  }

  return {
    action,
    bookingId: bookingIdParts.join(":")
  };
}

function getUserLabel(interaction: ButtonInteraction) {
  return interaction.user.globalName ?? interaction.user.username;
}

function buildDecision(
  type: MockOrderDecision["type"],
  interaction: ButtonInteraction,
  sourceBookingId: string,
  replacementBookingId?: string
): MockOrderDecision {
  return {
    decidedAt: new Date().toISOString(),
    replacementBookingId,
    sourceBookingId,
    type,
    userLabel: getUserLabel(interaction)
  };
}

async function buildTrackingState(
  bookingId: string,
  createdOrder?: CreatedMockOrder,
  decision?: MockOrderDecision
): Promise<MockOrderViewState> {
  const result = await getNextMockDelivereeTrackingResult(bookingId);

  return {
    bookingId,
    changed: result.changed,
    createdOrder,
    decision,
    notice: result.order ? undefined : `Booking ID ${bookingId} tidak ditemukan di mock data.`,
    order: result.order ?? undefined,
    previousStatus: result.previousStatus
  };
}

export async function handleMockOrderButtonInteraction(interaction: ButtonInteraction) {
  const parsed = parseMockOrderControlId(interaction.customId);

  if (!parsed) {
    return false;
  }

  try {
    if (parsed.action === "refresh") {
      const state = await buildTrackingState(parsed.bookingId);
      await interaction.update(buildMockOrderMessage(state, {
        controlsDisabled: !state.order
      }));
      return true;
    }

    if (parsed.action === "cancel") {
      untrackMockDelivereeBookingId(parsed.bookingId);
      const decision = buildDecision("cancel", interaction, parsed.bookingId);
      const state = await buildTrackingState(parsed.bookingId, undefined, decision);

      await interaction.update(buildMockOrderMessage(state, {
        controlsDisabled: true
      }));
      return true;
    }

    const replacementOrder = createReplacementMockOrder(parsed.bookingId);

    if (!replacementOrder) {
      await interaction.reply({
        content: `Booking ID \`${parsed.bookingId}\` tidak bisa dibuatkan replacement mock order.`,
        flags: ["Ephemeral"]
      });
      return true;
    }

    const decision = buildDecision("reorder", interaction, parsed.bookingId, replacementOrder.bookingId);
    const state = await buildTrackingState(replacementOrder.bookingId, replacementOrder, decision);

    await interaction.update(buildMockOrderMessage(state));
    return true;
  } catch (error) {
    console.error(`Gagal memproses kontrol mock order ${parsed.action} untuk ${parsed.bookingId}.`, error);

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "Gagal memproses kontrol mock order.",
        flags: ["Ephemeral"]
      });
      return true;
    }

    await interaction.reply({
      content: "Gagal memproses kontrol mock order.",
      flags: ["Ephemeral"]
    });
    return true;
  }
}
