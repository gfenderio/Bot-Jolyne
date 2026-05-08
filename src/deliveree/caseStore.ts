import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DelivereeWebStatus } from "./webClassifier.js";

export type DelivereeActionLogEntry = {
  action: string;
  afterStatus?: DelivereeWebStatus;
  at: string;
  beforeStatus?: DelivereeWebStatus;
  nonce?: string;
  note?: string;
  screenshotPath?: string;
  userId?: string;
};

export type DelivereeRecoveryCase = {
  actionLog: DelivereeActionLogEntry[];
  alertChannelId?: string;
  alertMessageId?: string;
  bookingId: string;
  caseId: string;
  closedAt?: string;
  lastObservedAt: string;
  lastScreenshotPath?: string;
  lastStatusChangeAt: string;
  retryCount: number;
  status: DelivereeWebStatus;
  url: string;
};

type StoreFile = {
  cases: DelivereeRecoveryCase[];
};

export type UpsertObservationInput = {
  bookingId: string;
  screenshotPath?: string;
  status: DelivereeWebStatus;
  url: string;
};

export class JsonDelivereeCaseStore {
  constructor(private readonly filePath: string) {}

  async listCases() {
    const store = await this.read();
    return store.cases;
  }

  async getCase(caseId: string) {
    const store = await this.read();
    return store.cases.find((recoveryCase) => recoveryCase.caseId === caseId);
  }

  async upsertObservation(input: UpsertObservationInput) {
    const store = await this.read();
    const now = new Date().toISOString();
    const caseId = input.bookingId;
    const existingIndex = store.cases.findIndex((recoveryCase) => recoveryCase.caseId === caseId);

    if (existingIndex === -1) {
      const recoveryCase: DelivereeRecoveryCase = {
        actionLog: [{
          action: "observed",
          afterStatus: input.status,
          at: now,
          note: "Initial Deliveree web observation.",
          screenshotPath: input.screenshotPath
        }],
        bookingId: input.bookingId,
        caseId,
        lastObservedAt: now,
        lastScreenshotPath: input.screenshotPath,
        lastStatusChangeAt: now,
        retryCount: 0,
        status: input.status,
        url: input.url
      };

      store.cases.push(recoveryCase);
      await this.write(store);
      return {
        changed: true,
        recoveryCase
      };
    }

    const existing = store.cases[existingIndex];
    const changed = existing.status !== input.status;
    const updated: DelivereeRecoveryCase = {
      ...existing,
      actionLog: [
        ...existing.actionLog,
        {
          action: "observed",
          afterStatus: input.status,
          at: now,
          beforeStatus: existing.status,
          note: changed ? "Deliveree web status changed." : "Deliveree web status unchanged.",
          screenshotPath: input.screenshotPath
        }
      ],
      lastObservedAt: now,
      lastScreenshotPath: input.screenshotPath ?? existing.lastScreenshotPath,
      lastStatusChangeAt: changed ? now : existing.lastStatusChangeAt,
      status: input.status,
      url: input.url
    };

    store.cases[existingIndex] = updated;
    await this.write(store);
    return {
      changed,
      recoveryCase: updated
    };
  }

  async appendActionLog(caseId: string, entry: Omit<DelivereeActionLogEntry, "at"> & { at?: string }) {
    const store = await this.read();
    const existingIndex = store.cases.findIndex((recoveryCase) => recoveryCase.caseId === caseId);

    if (existingIndex === -1) {
      return undefined;
    }

    const updated = {
      ...store.cases[existingIndex],
      actionLog: [
        ...store.cases[existingIndex].actionLog,
        {
          ...entry,
          at: entry.at ?? new Date().toISOString()
        }
      ]
    };

    store.cases[existingIndex] = updated;
    await this.write(store);
    return updated;
  }

  async hasActionNonce(caseId: string, nonce: string) {
    const recoveryCase = await this.getCase(caseId);
    return Boolean(recoveryCase?.actionLog.some((entry) => entry.nonce === nonce));
  }

  async setAlertMessage(caseId: string, channelId: string, messageId: string) {
    const store = await this.read();
    const existingIndex = store.cases.findIndex((recoveryCase) => recoveryCase.caseId === caseId);

    if (existingIndex === -1) {
      return undefined;
    }

    const updated = {
      ...store.cases[existingIndex],
      alertChannelId: channelId,
      alertMessageId: messageId
    };

    store.cases[existingIndex] = updated;
    await this.write(store);
    return updated;
  }

  async closeCase(caseId: string, userId: string, nonce?: string) {
    const store = await this.read();
    const existingIndex = store.cases.findIndex((recoveryCase) => recoveryCase.caseId === caseId);

    if (existingIndex === -1) {
      return undefined;
    }

    const now = new Date().toISOString();
    const updated = {
      ...store.cases[existingIndex],
      actionLog: [
        ...store.cases[existingIndex].actionLog,
        {
          action: "closed",
          at: now,
          beforeStatus: store.cases[existingIndex].status,
          nonce,
          note: "Recovery case closed from Discord.",
          userId
        }
      ],
      closedAt: now
    };

    store.cases[existingIndex] = updated;
    await this.write(store);
    return updated;
  }

  private async read(): Promise<StoreFile> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as StoreFile;
      return {
        cases: Array.isArray(parsed.cases) ? parsed.cases : []
      };
    } catch {
      return {
        cases: []
      };
    }
  }

  private async write(store: StoreFile) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(store, null, 2)}\n`);
  }
}
