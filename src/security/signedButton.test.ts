import assert from "node:assert";
import { test } from "node:test";
import { ButtonReplayGuard } from "./buttonReplayGuard.js";
import {
  createSignedDelivereeButtonId,
  parseSignedDelivereeButtonId
} from "./signedButton.js";

test("Signed Button - accepts a valid Deliveree button id", () => {
  const customId = createSignedDelivereeButtonId({
    action: "refresh",
    caseId: "19330506",
    nowMs: 1_000,
    secret: "test-secret"
  });

  const parsed = parseSignedDelivereeButtonId(customId, "test-secret", 2_000);

  assert.ok(parsed);
  assert.strictEqual(parsed.action, "refresh");
  assert.strictEqual(parsed.caseId, "19330506");
});

test("Signed Button - rejects tampered and expired ids", () => {
  const customId = createSignedDelivereeButtonId({
    action: "refresh",
    caseId: "19330506",
    expiresInMs: 1_000,
    nowMs: 1_000,
    secret: "test-secret"
  });
  const tampered = customId.replace("19330506", "19330507");

  assert.strictEqual(parseSignedDelivereeButtonId(tampered, "test-secret", 1_500), undefined);
  assert.strictEqual(parseSignedDelivereeButtonId(customId, "test-secret", 3_000), undefined);
});

test("Signed Button - replay guard rejects reused nonce", () => {
  const customId = createSignedDelivereeButtonId({
    action: "prepare_reorder",
    caseId: "19330506",
    nowMs: 1_000,
    secret: "test-secret"
  });
  const parsed = parseSignedDelivereeButtonId(customId, "test-secret", 2_000);
  const guard = new ButtonReplayGuard();

  assert.ok(parsed);
  assert.strictEqual(guard.consume(parsed, 2_000), true);
  assert.strictEqual(guard.consume(parsed, 2_000), false);
});
