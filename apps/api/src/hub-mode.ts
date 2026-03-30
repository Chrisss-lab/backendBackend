/**
 * Single-site hub backed by Google Sheet (Apps Script) for business data.
 * When enabled, no separate PostgreSQL service is required — Prisma uses an embedded SQLite file
 * only for optional webhook dedup; login is Google Sheet session → JWT (no User rows required).
 */
export function isHubSheetOnly(): boolean {
  const v = process.env.HUB_SHEET_ONLY?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}
