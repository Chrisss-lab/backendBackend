/**
 * API origin for fetch() calls.
 * - If NEXT_PUBLIC_API_URL is set → use it (trimmed, no trailing slash).
 * - Else in the browser → same origin (unified Nest + static on one port).
 * - Else (SSR/build) → localhost fallback.
 */
export function getPublicApiBase(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_API_URL ?? "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin.replace(/\/$/, "");
  }
  return "http://127.0.0.1:4000";
}
