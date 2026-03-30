"use client";

import { type ReactNode, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getStoredApiToken } from "../lib/auth-token";
import { exchangeSheetTokenForApiJwt } from "../lib/auth-sheet-exchange";
import { hubAuthEnforced } from "../lib/hub-login-policy";
import {
  getStoredSheetSession,
  setStoredSheetSession,
  sheetWebLoginEnabled,
  verifySheetSessionBestEffort
} from "../lib/sheet-web-session";

function LoadingScreen({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#eef3ee",
        color: "#1f2a21",
        fontFamily: "Inter, Arial, sans-serif"
      }}
    >
      <p style={{ margin: 0 }}>{message}</p>
    </div>
  );
}

export default function SessionGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [bootDone, setBootDone] = useState(false);

  useEffect(() => {
    if (!hubAuthEnforced()) {
      setBootDone(true);
      return;
    }
    void (async () => {
      if (sheetWebLoginEnabled() && !getStoredApiToken()) {
        const sheetTok = getStoredSheetSession();
        if (sheetTok) {
          const pingOk = await verifySheetSessionBestEffort();
          if (pingOk) {
            await exchangeSheetTokenForApiJwt(sheetTok);
          } else {
            setStoredSheetSession(null);
          }
        }
      }
      setBootDone(true);
    })();
  }, []);

  useEffect(() => {
    if (!bootDone || !hubAuthEnforced()) return;
    const token = getStoredApiToken();
    if (pathname === "/login") {
      if (token) router.replace("/");
      return;
    }
    if (!token) router.replace("/login");
  }, [bootDone, pathname, router]);

  /** Back/forward cache restore: old HTML can resurface without our client state. */
  useEffect(() => {
    if (!hubAuthEnforced()) return;
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      if (pathname !== "/login" && !getStoredApiToken()) {
        window.location.replace("/login");
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [pathname]);

  /** Returning from another tab or from a search-result open should re-check auth. */
  useEffect(() => {
    if (!hubAuthEnforced()) return;
    const onFocus = () => {
      if (pathname === "/login") return;
      if (!getStoredApiToken()) {
        router.replace("/login");
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pathname, router]);

  if (!hubAuthEnforced()) {
    return <>{children}</>;
  }

  if (!bootDone) {
    return <LoadingScreen message="Checking session…" />;
  }

  const token = getStoredApiToken();

  if (pathname !== "/login" && !token) {
    return <LoadingScreen message="Redirecting to sign in…" />;
  }

  if (pathname === "/login" && token) {
    return <LoadingScreen message="Redirecting…" />;
  }

  return <>{children}</>;
}
