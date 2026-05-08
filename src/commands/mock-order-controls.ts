import { ComponentType } from "discord.js";
import type { ChatInputCommandInteraction, Message } from "discord.js";
import { buildMockOrderMessage } from "../deliveree/mockOrderEmbed.js";
import { getNextMockDelivereeTrackingResult, untrackMockDelivereeBookingId } from "../deliveree/mockRuntime.js";
import type { MockOrderDecision, MockOrderViewState } from "../deliveree/mockOrderEmbed.js";

type MockOrderControlAction = "cancel" | "refresh" | "reorder";

type ParsedMockOrderControlId = {
  action: MockOrderControlAction;
  bookingId: string;
};

function parseMockOrderControlId(customId: string): ParsedMockOrderControlId | undefined {
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

function getUserLabel(interaction: ChatInputCommandInteraction) {
  return interaction.user.globalName ?? interaction.user.username;
}

function buildDecision(type: MockOrderDecision["type"], interaction: ChatInputCommandInteraction): MockOrderDecision {
  return {
    decidedAt: new Date().toISOString(),
    type,
    userLabel: getUserLabel(interaction)
  };
}

export function attachMockOrderControls(
  interaction: ChatInputCommandInteraction,
  message: Message,
  initialState: MockOrderViewState
) {
  let state = initialState;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 180_000
  });

  collector.on("collect", async (buttonInteraction) => {
    const parsed = parseMockOrderControlId(buttonInteraction.customId);

    if (!parsed || parsed.bookingId !== state.bookingId) {
      return;
    }

    if (buttonInteraction.user.id !== interaction.user.id) {
      await buttonInteraction.reply({
        content: "Kontrol mock order ini hanya bisa digunakan oleh pemanggil command.",
        flags: ["Ephemeral"]
      });
      return;
    }

    try {
      if (parsed.action === "refresh") {
        const result = await getNextMockDelivereeTrackingResult(parsed.bookingId);

        state = {
          ...state,
          changed: result.changed,
          notice: result.order ? undefined : `Booking ID ${parsed.bookingId} tidak ditemukan di mock data.`,
          order: result.order ?? undefined,
          previousStatus: result.previousStatus
        };

        await buttonInteraction.update(buildMockOrderMessage(state, {
          controlsDisabled: !result.order
        }));
        return;
      }

      if (parsed.action === "cancel") {
        untrackMockDelivereeBookingId(parsed.bookingId);
      }

      state = {
        ...state,
        decision: buildDecision(parsed.action, interaction),
        notice: undefined
      };

      await buttonInteraction.update(buildMockOrderMessage(state));
    } catch (error) {
      console.error(`Gagal memproses kontrol mock order ${parsed.action} untuk ${parsed.bookingId}.`, error);
      await buttonInteraction.reply({
        content: "Gagal memproses kontrol mock order.",
        flags: ["Ephemeral"]
      });
    }
  });

  collector.on("end", async () => {
    await interaction.editReply(buildMockOrderMessage(state, {
      controlsDisabled: true
    })).catch(() => undefined);
  });
}
