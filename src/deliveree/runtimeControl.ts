import { env } from "../config/env.js";

export type DelivereeRuntimeMode = typeof env.DELIVEREE_ACTION_MODE;

let currentMode: DelivereeRuntimeMode = env.DELIVEREE_ACTION_MODE;

export function getDelivereeRuntimeMode() {
  return currentMode;
}

export function setDelivereeRuntimeMode(mode: DelivereeRuntimeMode) {
  currentMode = mode;
}

export function isDelivereePaused() {
  return currentMode === "paused";
}

