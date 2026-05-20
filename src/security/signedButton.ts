import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DELIVEREE_BUTTON_SCOPE = "deliv";

export const DELIVEREE_BUTTON_ACTIONS = [
  "close",
  "ignore",
  "manual_reorder",
  "need_followup",
  "prepare_reorder",
  "refresh",
  "turn_off_auto_retry"
] as const;

export type DelivereeButtonAction = (typeof DELIVEREE_BUTTON_ACTIONS)[number];

export type ParsedSignedButtonId = {
  action: DelivereeButtonAction;
  caseId: string;
  expiresAt: number;
  nonce: string;
};

type SignButtonOptions = {
  action: DelivereeButtonAction;
  caseId: string;
  expiresInMs?: number;
  nowMs?: number;
  secret: string;
};

const DEFAULT_EXPIRES_IN_MS = 15 * 60_000;
const SIGNATURE_LENGTH = 18;

function isDelivereeButtonAction(action: string): action is DelivereeButtonAction {
  return DELIVEREE_BUTTON_ACTIONS.includes(action as DelivereeButtonAction);
}

function signPayload(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url")
    .slice(0, SIGNATURE_LENGTH);
}

function timingSafeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createSignedDelivereeButtonId(options: SignButtonOptions) {
  const nowMs = options.nowMs ?? Date.now();
  const expiresAt = Math.floor((nowMs + (options.expiresInMs ?? DEFAULT_EXPIRES_IN_MS)) / 1000);
  const nonce = randomBytes(6).toString("base64url");
  const payload = [
    DELIVEREE_BUTTON_SCOPE,
    options.action,
    options.caseId,
    expiresAt,
    nonce
  ].join(":");
  const signature = signPayload(payload, options.secret);

  return `${payload}:${signature}`;
}

export function parseSignedDelivereeButtonId(
  customId: string,
  secret: string,
  nowMs = Date.now()
): ParsedSignedButtonId | undefined {
  const [scope, action, caseId, expiresAtText, nonce, signature, ...extra] = customId.split(":");

  if (extra.length || scope !== DELIVEREE_BUTTON_SCOPE || !isDelivereeButtonAction(action)) {
    return undefined;
  }

  if (!caseId || !expiresAtText || !nonce || !signature) {
    return undefined;
  }

  const expiresAt = Number(expiresAtText);

  if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= nowMs) {
    return undefined;
  }

  const payload = [scope, action, caseId, expiresAt, nonce].join(":");
  const expectedSignature = signPayload(payload, secret);

  if (!timingSafeStringEqual(signature, expectedSignature)) {
    return undefined;
  }

  return {
    action,
    caseId,
    expiresAt,
    nonce
  };
}

