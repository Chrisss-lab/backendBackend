/**
 * Same Google Calendar bridge as JR Workers ACCES (`src/api/calendar.js`).
 * Set NEXT_PUBLIC_JR_WORKERS_CALENDAR_APPS_SCRIPT_URL to your deployed Web App /exec URL.
 */

export type JrWorkersAppsScriptEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  when?: string;
};

export type WorkersCalendarClientRow = {
  id: string;
  uid: string;
  title: string;
  date: string;
  time: string;
  allDay: boolean;
  start: string;
  end: string;
  description: string;
  location: string;
  sourceFile: string;
  /** Enables add/edit/delete in Management Hub */
  workersRemote: "apps-script" | "ics";
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export function localDateTimeValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function toISOFromLocalDatetimeInput(value: string): string {
  const d = new Date(value);
  return d.toISOString();
}

export function jrWorkersCalendarAppsScriptConfigured(): boolean {
  return Boolean((process.env.NEXT_PUBLIC_JR_WORKERS_CALENDAR_APPS_SCRIPT_URL ?? "").trim());
}

function calendarApiUrl(): string {
  const url = (process.env.NEXT_PUBLIC_JR_WORKERS_CALENDAR_APPS_SCRIPT_URL ?? "").trim();
  if (!url) throw new Error("JR Workers Calendar API not configured. Set NEXT_PUBLIC_JR_WORKERS_CALENDAR_APPS_SCRIPT_URL in apps/web/.env.local");
  return url;
}

export async function listJrWorkersCalendarEvents({ startISO, endISO }: { startISO: string; endISO: string }) {
  const CALENDAR_API_URL = calendarApiUrl();
  const url =
    `${CALENDAR_API_URL}?action=list` +
    `&start=${encodeURIComponent(startISO)}` +
    `&end=${encodeURIComponent(endISO)}`;
  const res = await fetch(url);
  const data = (await res.json()) as { success?: boolean; error?: string; events?: JrWorkersAppsScriptEvent[] };
  if (!data.success) throw new Error(data.error || "Failed to load JR Workers calendar events");
  return data.events || [];
}

export async function createJrWorkersCalendarEvent(payload: {
  title: string;
  startISO: string;
  endISO: string;
  location?: string;
  description?: string;
}) {
  const CALENDAR_API_URL = calendarApiUrl();
  const res = await fetch(CALENDAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "create", ...payload })
  });
  const data = (await res.json()) as { success?: boolean; error?: string; event?: JrWorkersAppsScriptEvent };
  if (!data.success) throw new Error(data.error || "Failed to create event");
  return data.event;
}

export async function updateJrWorkersCalendarEvent(
  id: string,
  payload: {
    title: string;
    startISO: string;
    endISO: string;
    location?: string;
    description?: string;
  }
) {
  const CALENDAR_API_URL = calendarApiUrl();
  const res = await fetch(CALENDAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "update", id, ...payload })
  });
  const data = (await res.json()) as { success?: boolean; error?: string };
  if (!data.success) throw new Error(data.error || "Failed to update event");
  return true;
}

export async function deleteJrWorkersCalendarEvent(id: string) {
  const CALENDAR_API_URL = calendarApiUrl();
  const res = await fetch(CALENDAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "delete", id })
  });
  const data = (await res.json()) as { success?: boolean; error?: string };
  if (!data.success) throw new Error(data.error || "Failed to delete event");
  return true;
}

function inferAllDay(start: Date, end: Date): boolean {
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return false;
  // Treat midnight-to-midnight (or longer) as all-day-ish
  if (start.getHours() === 0 && start.getMinutes() === 0 && ms >= 23.5 * 60 * 60 * 1000) return true;
  return false;
}

export function appsScriptEventToWorkersClientEvent(ev: JrWorkersAppsScriptEvent): WorkersCalendarClientRow {
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  const allDay = inferAllDay(start, end);
  const ymd = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
  const time = allDay ? "" : `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
  return {
    id: ev.id,
    uid: ev.id,
    title: ev.title || "",
    date: ymd,
    time,
    allDay,
    start: ev.start,
    end: ev.end,
    description: ev.description || "",
    location: ev.location || "",
    sourceFile: "Google Calendar (Apps Script)",
    workersRemote: "apps-script"
  };
}
