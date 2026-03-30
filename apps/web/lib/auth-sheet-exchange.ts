import { getPublicApiBase } from "./api-base";
import { setStoredApiToken } from "./auth-token";
import { setStoredSheetSession } from "./sheet-web-session";

export async function exchangeSheetTokenForApiJwt(
  sessionToken: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await fetch(`${getPublicApiBase()}/auth/sheet-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionToken })
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, message: text || `API returned ${res.status}` };
  }
  try {
    const data = JSON.parse(text) as { accessToken?: string };
    if (!data.accessToken) return { ok: false, message: "Invalid API response (no accessToken)." };
    setStoredApiToken(data.accessToken);
    setStoredSheetSession(null);
    return { ok: true };
  } catch {
    return { ok: false, message: "Invalid API response." };
  }
}
