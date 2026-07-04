import { env } from "../config/env.js";

/**
 * Auth bersama untuk semua endpoint intake Machitan.
 * Token valid diambil dari env MACHITAN_INTAKE_TOKENS (comma-separated) —
 * bisa lebih dari satu selama masa rotasi token.
 */
export function isAuthorizedMachitanIntake(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  return env.MACHITAN_INTAKE_TOKENS.some((token) => authHeader === `Bearer ${token}`);
}
