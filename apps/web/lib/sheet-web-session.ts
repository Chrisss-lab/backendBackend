const SESSION_KEY = "jr_sheet_web_session_token";

function sheetWebLoginExplicitlyOff(): boolean {
  const f = (process.env.NEXT_PUBLIC_SHEET_WEB_LOGIN ?? "").trim().toLowerCase();
  return f === "0" || f === "false" || f === "no" || f === "off";
}

/**
 * WebLogin (username + password) when true: browser POSTs /auth/sheet-web-login (API calls Apps Script; no CORS).
 * Default ON so same-origin and split-dev work without NEXT_PUBLIC_JR_SHEET_APPS_SCRIPT_URL in the client — only the API needs GOOGLE_SHEET_APPS_SCRIPT_URL.
 * OFF if NEXT_PUBLIC_SHEET_WEB_LOGIN is 0/false/no/off (Nest email/password only on /auth/login).
 */
export function sheetWebLoginEnabled(): boolean {
  if (sheetWebLoginExplicitlyOff()) return false;
  return true;
}

export function getSheetWebAppUrl(): string {
  return (process.env.NEXT_PUBLIC_JR_SHEET_APPS_SCRIPT_URL ?? "").trim().replace(/\/$/, "");
}

export function getStoredSheetSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setStoredSheetSession(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export async function verifySheetSessionBestEffort(): Promise<boolean> {
  const tok = getStoredSheetSession();
  const base = getSheetWebAppUrl();
  if (!tok || !base) return false;
  try {
    const res = await fetch(
      `${base}?action=sessionPing&sessionToken=${encodeURIComponent(tok)}`,
      { method: "GET", credentials: "omit" }
    );
    const data = (await res.json()) as { ok?: boolean; valid?: boolean };
    return Boolean(data.ok && data.valid);
  } catch {
    return false;
  }
}
