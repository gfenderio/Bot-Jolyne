import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DelivereeExtensionEventType,
  DelivereeExtensionPageKind
} from "./extensionDomExtractor.js";
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
  destinationCount?: number;
  deviceId?: string;
  driverName?: string;
  duplicateUrl?: string;
  etaText?: string;
  eventType?: DelivereeExtensionEventType;
  failureReason?: string;
  jobNo?: string;
  lastHeartbeatAt?: string;
  lastPageKind?: DelivereeExtensionPageKind;
  lastObservedAt: string;
  lastScreenshotPath?: string;
  lastStatusChangeAt: string;
  lateText?: string;
  plateNumber?: string;
  retryAttempt?: number;
  retryCount: number;
  retryStartedAt?: string;
  retryStopReason?: string;
  serviceType?: string;
  silencedAt?: string;
  silenceReason?: string;
  status: DelivereeWebStatus;
  statusText?: string;
  stuckDriverAlertSentAt?: string;
  totalDistanceKm?: number;
  vehicleDescription?: string;
  url: string;
};

type StoreFile = {
  cases: DelivereeRecoveryCase[];
};

export type UpsertObservationInput = {
  bookingId: string;
  destinationCount?: number;
  deviceId?: string;
  driverName?: string;
  duplicateUrl?: string;
  etaText?: string;
  eventType?: DelivereeExtensionEventType;
  failureReason?: string;
  jobNo?: string;
  lastHeartbeatAt?: string;
  lastPageKind?: DelivereeExtensionPageKind;
  lateText?: string;
  observedAt?: string;
  plateNumber?: string;
  recordUnchangedAction?: boolean;
  retryAttempt?: number;
  retryStartedAt?: string;
  retryStopReason?: string;
  serviceType?: string;
  screenshotPath?: string;
  status: DelivereeWebStatus;
  statusStartedAt?: string;
  statusText?: string;
  totalDistanceKm?: number;
  url: string;
  vehicleDescription?: string;
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
    const observedAt = input.observedAt ?? now;
    const caseId = input.bookingId;
    const existingIndex = store.cases.findIndex((recoveryCase) => recoveryCase.caseId === caseId);

    if (existingIndex === -1) {
      const recoveryCase: DelivereeRecoveryCase = {
        actionLog: [{
          action: "observed",
          afterStatus: input.status,
          at: observedAt,
          note: input.lastPageKind
            ? "Initial Deliveree extension observation."
            : "Initial Deliveree web observation.",
          screenshotPath: input.screenshotPath
        }],
        bookingId: input.bookingId,
        caseId,
        destinationCount: input.destinationCount,
        deviceId: input.deviceId,
        driverName: input.driverName,
        duplicateUrl: input.duplicateUrl,
        etaText: input.etaText,
        eventType: input.eventType,
        failureReason: input.failureReason,
        jobNo: input.jobNo,
        lastHeartbeatAt: input.lastHeartbeatAt,
        lastPageKind: input.lastPageKind,
        lastObservedAt: observedAt,
        lastScreenshotPath: input.screenshotPath,
        lastStatusChangeAt: input.statusStartedAt ?? observedAt,
        lateText: input.lateText,
        plateNumber: input.plateNumber,
        retryAttempt: input.retryAttempt,
        retryCount: 0,
        retryStartedAt: input.retryStartedAt,
        retryStopReason: input.retryStopReason,
        serviceType: input.serviceType,
        status: input.status,
        statusText: input.statusText,
        totalDistanceKm: input.totalDistanceKm,
        vehicleDescription: input.vehicleDescription,
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
    const shouldRecordAction = changed || input.recordUnchangedAction !== false;
    const updated: DelivereeRecoveryCase = {
      ...existing,
      actionLog: shouldRecordAction
        ? [
            ...existing.actionLog,
            {
              action: "observed",
              afterStatus: input.status,
              at: observedAt,
              beforeStatus: existing.status,
              note: changed ? "Deliveree status changed." : "Deliveree status unchanged.",
              screenshotPath: input.screenshotPath
            }
          ]
        : existing.actionLog,
      destinationCount: input.destinationCount ?? existing.destinationCount,
      deviceId: input.deviceId ?? existing.deviceId,
      driverName: input.driverName ?? existing.driverName,
      duplicateUrl: input.duplicateUrl ?? existing.duplicateUrl,
      etaText: input.etaText ?? existing.etaText,
      eventType: input.eventType ?? existing.eventType,
      failureReason: input.failureReason ?? existing.failureReason,
      jobNo: input.jobNo ?? existing.jobNo,
      lastHeartbeatAt: input.lastHeartbeatAt ?? existing.lastHeartbeatAt,
      lastPageKind: input.lastPageKind ?? existing.lastPageKind,
      lastObservedAt: observedAt,
      lastScreenshotPath: input.screenshotPath ?? existing.lastScreenshotPath,
      lastStatusChangeAt: changed ? input.statusStartedAt ?? observedAt : existing.lastStatusChangeAt,
      lateText: input.lateText ?? existing.lateText,
      plateNumber: input.plateNumber ?? existing.plateNumber,
      retryAttempt: input.retryAttempt ?? existing.retryAttempt,
      retryStartedAt: input.retryStartedAt ?? existing.retryStartedAt,
      retryStopReason: input.retryStopReason ?? existing.retryStopReason,
      serviceType: input.serviceType ?? existing.serviceType,
      status: input.status,
      statusText: input.statusText ?? existing.statusText,
      totalDistanceKm: input.totalDistanceKm ?? existing.totalDistanceKm,
      vehicleDescription: input.vehicleDescription ?? existing.vehicleDescription,
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

  async silenceCase(caseId: string, userId: string, reason?: string, nonce?: string) {
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
          action: "silenced",
          at: now,
          beforeStatus: store.cases[existingIndex].status,
          nonce,
          note: reason || "Recovery case silenced from Discord.",
          userId
        }
      ],
      silencedAt: now,
      silenceReason: reason
    };

    store.cases[existingIndex] = updated;
    await this.write(store);
    return updated;
  }

  async closeCase(
    caseId: string,
    userId: string,
    nonce?: string,
    action = "closed",
    note = "Recovery case closed from Discord."
  ) {
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
          action,
          at: now,
          beforeStatus: store.cases[existingIndex].status,
          nonce,
          note,
          userId
        }
      ],
      closedAt: now
    };

    store.cases[existingIndex] = updated;
    await this.write(store);
    return updated;
  }

  async markStuckDriverAlertSent(caseId: string) {
    const store = await this.read();
    const existingIndex = store.cases.findIndex((recoveryCase) => recoveryCase.caseId === caseId);

    if (existingIndex === -1) {
      return undefined;
    }

    const now = new Date().toISOString();
    const updated = {
      ...store.cases[existingIndex],
      stuckDriverAlertSentAt: now
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
