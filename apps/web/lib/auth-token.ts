import { setStoredSheetSession } from "./sheet-web-session";

const KEY = "jr_api_access_token";

export function getStoredApiToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setStoredApiToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearStoredApiToken(): void {
  setStoredApiToken(null);
}

/**
 * Clears API + sheet browser session and opens /login (full navigation).
 * Use when the API returns 401 or the hub must force sign-in again.
 */
export function forceHubReLogin(): void {
  if (typeof window === "undefined") return;
  try {
    clearStoredApiToken();
    setStoredSheetSession(null);
  } catch {
    /* ignore */
  }
  const path = window.location.pathname || "/";
  if (path === "/login") {
    window.location.reload();
    return;
  }
  window.location.replace("/login");
}

/** Merge Authorization: Bearer when a token exists (for JSON / DELETE requests). */
export function authFetchHeaders(base?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...(base || {}) };
  const t = getStoredApiToken();
  if (t) out.Authorization = `Bearer ${t}`;
  return out;
}

/** GET a protected resource and save as a file (CSV, etc.). New-tab links cannot send Bearer tokens. */
export async function downloadWithAuth(fullUrl: string, suggestedFileName: string): Promise<void> {
  if (typeof window === "undefined") return;
  const res = await fetch(fullUrl, { headers: authFetchHeaders() });
  if (res.status === 401) {
    forceHubReLogin();
    throw new Error("Session expired.");
  }
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = suggestedFileName || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(u);
}
