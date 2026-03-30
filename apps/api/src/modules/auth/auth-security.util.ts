import { timingSafeEqual } from "node:crypto";

/** When true, all routes stay open (local tooling only — never in production). */
export function apiAuthDisabled(): boolean {
  const v = process.env.API_AUTH_DISABLED?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** JWT required for Nest routes (unless @Public or API_AUTH_DISABLED). */
export function jwtAuthEnforced(): boolean {
  if (apiAuthDisabled()) return false;
  if (process.env.REQUIRE_API_AUTH === "true" || process.env.REQUIRE_API_AUTH === "1") return true;
  return process.env.NODE_ENV === "production";
}

export function assertProductionJwtSecret(): void {
  if (!jwtAuthEnforced()) return;
  const s = process.env.JWT_SECRET?.trim() ?? "";
  if (s.length < 32) {
    throw new Error(
      "[api] JWT_SECRET must be set to a random string of at least 32 characters when API authentication is enforced (production or REQUIRE_API_AUTH)."
    );
  }
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
