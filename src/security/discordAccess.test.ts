import assert from "node:assert";
import { test } from "node:test";
import {
  getDelivereeAccessDeniedReason,
  isDelivereeOwnerUser
} from "./discordAccess.js";

test("Discord Access - recognizes configured Deliveree owner", () => {
  assert.strictEqual(isDelivereeOwnerUser("419213146209779713"), true);
  assert.strictEqual(isDelivereeOwnerUser("123"), false);
});

test("Discord Access - rejects non-owner Deliveree action", () => {
  const deniedReason = getDelivereeAccessDeniedReason({
    channelId: "1501899831268868106",
    guildId: null,
    user: {
      id: "123"
    }
  });

  assert.match(deniedReason ?? "", /owner/);
});

