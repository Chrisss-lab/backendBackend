"use client";

import { getPublicApiBase } from "./api-base";
import { authFetchHeaders, forceHubReLogin } from "./auth-token";

function isUnreachableBackendError(error: unknown): boolean {
  const msg = String((error as Error)?.message ?? error ?? "").toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror when attempting to fetch") ||
    msg.includes("network request failed") ||
    msg.includes("load failed")
  );
}

function backendUnreachableMessage(context: string): string {
  const base = getPublicApiBase();
  return `${context} — cannot reach ${base}. Run Start.cmd (one port) or "npm run build:web && npm run start:dev -w apps/api", then open that URL in the browser. Split dev: set NEXT_PUBLIC_API_URL in apps/web/.env.local and run web + API separately.`;
}

async function withApiErrorMapping<T>(action: () => Promise<T>, context: string): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    if (isUnreachableBackendError(error)) {
      throw new Error(backendUnreachableMessage(context));
    }
    throw error;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  return withApiErrorMapping(async () => {
    const res = await fetch(`${getPublicApiBase()}${path}`, { headers: authFetchHeaders() });
    if (res.status === 401) {
      forceHubReLogin();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, "Request failed");
}

export async function apiGetWithQuery<T>(path: string, query: Record<string, string | undefined>): Promise<T> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => {
    if (v && v.trim() !== "") params.set(k, v);
  });
  const q = params.toString();
  return apiGet<T>(q ? `${path}?${q}` : path);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return withApiErrorMapping(async () => {
    const res = await fetch(`${getPublicApiBase()}${path}`, {
      method: "POST",
      headers: authFetchHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    if (res.status === 401) {
      forceHubReLogin();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, "Save failed");
}

export async function apiPostForm<T>(path: string, body: FormData): Promise<T> {
  return withApiErrorMapping(async () => {
    const res = await fetch(`${getPublicApiBase()}${path}`, {
      method: "POST",
      headers: authFetchHeaders(),
      body
    });
    if (res.status === 401) {
      forceHubReLogin();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, "Upload failed");
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return withApiErrorMapping(async () => {
    const res = await fetch(`${getPublicApiBase()}${path}`, {
      method: "PUT",
      headers: authFetchHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    if (res.status === 401) {
      forceHubReLogin();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, "Update failed");
}

export async function apiDelete(path: string): Promise<void> {
  return withApiErrorMapping(async () => {
    const res = await fetch(`${getPublicApiBase()}${path}`, { method: "DELETE", headers: authFetchHeaders() });
    if (res.status === 401) {
      forceHubReLogin();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) throw new Error(await res.text());
  }, "Delete failed");
}
