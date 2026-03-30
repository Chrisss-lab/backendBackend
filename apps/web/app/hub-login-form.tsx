"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { getPublicApiBase } from "../lib/api-base";
import { setStoredApiToken } from "../lib/auth-token";
import { sheetWebLoginEnabled } from "../lib/sheet-web-session";

function nestErrorMessage(rawText: string): string {
  try {
    const j = JSON.parse(rawText) as { message?: string | string[] };
    const m = j.message;
    if (typeof m === "string") return m;
    if (Array.isArray(m)) return m.map(String).join("; ");
  } catch {
    /* use raw */
  }
  return rawText;
}

export default function HubLoginForm() {
  const router = useRouter();
  const sheetMode = sheetWebLoginEnabled();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (sheetMode) {
        const res = await fetch(`${getPublicApiBase()}/auth/sheet-web-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: loginId.trim(),
            password: String(password)
          })
        });
        const rawText = await res.text();
        let data: { accessToken?: string; message?: string };
        try {
          data = JSON.parse(rawText) as typeof data;
        } catch {
          setErr(`Sign-in failed (HTTP ${res.status}). ${rawText.slice(0, 200)}`);
          return;
        }
        if (!res.ok) {
          setErr(
            nestErrorMessage(rawText) ||
              `Sign-in failed (${res.status}). Set GOOGLE_SHEET_LOGIN_APPS_SCRIPT_URL (or GOOGLE_SHEET_APPS_SCRIPT_URL) on the API and add WebLogin rows from row 2.`
          );
          return;
        }
        if (!data.accessToken) {
          setErr("Invalid API response. Ensure a DB user exists (seed-if-empty or POST /auth/seed-owner).");
          return;
        }
        setStoredApiToken(data.accessToken);
        router.replace("/");
        router.refresh();
        return;
      }

      const res = await fetch(`${getPublicApiBase()}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginId.trim(), password })
      });
      const text = await res.text();
      if (!res.ok) {
        setErr(nestErrorMessage(text) || "Sign-in failed.");
        return;
      }
      let data: { accessToken?: string };
      try {
        data = JSON.parse(text) as { accessToken?: string };
      } catch {
        setErr("Invalid response from server.");
        return;
      }
      if (!data.accessToken) {
        setErr("Invalid response from server.");
        return;
      }
      setStoredApiToken(data.accessToken);
      router.replace("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#eef3ee" }}>
      <section style={{ maxWidth: 420, width: "100%" }}>
        <h1 style={{ marginTop: 0 }}>Sign in</h1>
        {!sheetMode ? (
          <p style={{ color: "var(--text-soft, #4a6150)", fontSize: 14, lineHeight: 1.45 }}>
            This site talks to your deployed API with authentication enabled. Create the first owner with{" "}
            <code style={{ fontSize: 12 }}>POST /auth/seed-owner</code> and header <code style={{ fontSize: 12 }}>X-Setup-Secret</code>{" "}
            (see <code style={{ fontSize: 12 }}>deploy/DEPLOYMENT.md</code>), then sign in here.
          </p>
        ) : null}
        {err ? (
          <p style={{ color: "#b42318", fontSize: 14 }} role="alert">
            {err}
          </p>
        ) : null}
        <form onSubmit={onSubmit}>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>{sheetMode ? "Username" : "Email"}</span>
            <input
              type={sheetMode ? "text" : "email"}
              autoComplete="username"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              required
              style={{ width: "100%" }}
            />
          </label>
          <label style={{ display: "block", marginBottom: 14 }}>
            <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={sheetMode ? 1 : 8}
              style={{ width: "100%" }}
            />
          </label>
          <button type="submit" className="hub-btn-primary" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </div>
  );
}
