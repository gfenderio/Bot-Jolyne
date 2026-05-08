import { env } from "../config/env.js";
import { JsonDelivereeCaseStore } from "./caseStore.js";
import { DelivereeWebClient } from "./webClient.js";

export function createDelivereeCaseStore() {
  return new JsonDelivereeCaseStore(env.DELIVEREE_CASE_STORE_PATH);
}

export function createDelivereeWebClient() {
  return new DelivereeWebClient({
    profileDir: env.DELIVEREE_PLAYWRIGHT_PROFILE_DIR,
    screenshotDir: env.DELIVEREE_SCREENSHOT_DIR
  });
}

