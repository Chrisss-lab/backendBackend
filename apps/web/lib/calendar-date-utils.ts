export function calendarStartOfWeekSunday(ymd: string): Date {
  const d = new Date(ymd + "T12:00:00");
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function calendarEndOfWeekSaturday(ymd: string): Date {
  const s = calendarStartOfWeekSunday(ymd);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  e.setHours(23, 59, 59, 999);
  return e;
}

export function calendarDateInWeek(eventYmd: string, weekAnyDayYmd: string): boolean {
  const d = new Date(eventYmd + "T12:00:00").getTime();
  const ws = calendarStartOfWeekSunday(weekAnyDayYmd).getTime();
  const we = calendarEndOfWeekSaturday(weekAnyDayYmd).getTime();
  return d >= ws && d <= we;
}

export function calendarAddDaysYmd(ymd: string, delta: number): string {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function calendarMonthGridCells(year: number, monthIndex0: number): { day: number | null; ymd: string | null }[] {
  const first = new Date(year, monthIndex0, 1);
  const last = new Date(year, monthIndex0 + 1, 0);
  const startPad = first.getDay();
  const daysInMonth = last.getDate();
  const cells: { day: number | null; ymd: string | null }[] = [];
  for (let i = 0; i < startPad; i++) cells.push({ day: null, ymd: null });
  const ym = `${year}-${String(monthIndex0 + 1).padStart(2, "0")}`;
  for (let day = 1; day <= daysInMonth; day++) {
    const ymd = `${ym}-${String(day).padStart(2, "0")}`;
    cells.push({ day, ymd });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, ymd: null });
  return cells;
}

export function workersCalendarAppsScriptRange(ym: string, weekYmd: string): { startISO: string; endISO: string } {
  const parts = ym.split("-").map(Number);
  const y = parts[0] ?? new Date().getFullYear();
  const m = parts[1] ?? 1;
  const monthStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
  const ws = calendarStartOfWeekSunday(weekYmd);
  const we = calendarEndOfWeekSaturday(weekYmd);
  const rs = new Date(Math.min(monthStart.getTime(), ws.getTime()));
  rs.setDate(rs.getDate() - 14);
  rs.setHours(0, 0, 0, 0);
  const re = new Date(Math.max(monthEnd.getTime(), we.getTime()));
  re.setDate(re.getDate() + 14);
  re.setHours(23, 59, 59, 999);
  return { startISO: rs.toISOString(), endISO: re.toISOString() };
}
