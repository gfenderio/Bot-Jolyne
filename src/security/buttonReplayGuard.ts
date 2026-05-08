import type { ParsedSignedButtonId } from "./signedButton.js";

export class ButtonReplayGuard {
  private readonly usedNonces = new Map<string, number>();

  consume(parsed: ParsedSignedButtonId, nowMs = Date.now()) {
    this.prune(nowMs);

    const key = `${parsed.caseId}:${parsed.action}:${parsed.nonce}`;

    if (this.usedNonces.has(key)) {
      return false;
    }

    this.usedNonces.set(key, parsed.expiresAt * 1000);
    return true;
  }

  private prune(nowMs: number) {
    for (const [key, expiresAtMs] of this.usedNonces) {
      if (expiresAtMs <= nowMs) {
        this.usedNonces.delete(key);
      }
    }
  }
}

export const delivereeButtonReplayGuard = new ButtonReplayGuard();

