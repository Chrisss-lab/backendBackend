import { existsSync, mkdirSync, readdirSync } from "fs";
import { resolve } from "path";

/**
 * Absolute path to the `apps/api` folder (works no matter where `node` was started from).
 * Compiled output lives in `apps/api/dist`, so parent of `dist` is the API root.
 */
export function getApiRoot(): string {
  return resolve(__dirname, "..");
}

export function getUploadsRoot(): string {
  return resolve(getApiRoot(), "uploads");
}

/**
 * Monorepo root (`Backend/`), i.e. parent of `apps/`.
 * From `apps/api/dist/*.js`, `getApiRoot()` is `apps/api`, so go up two levels.
 */
export function getBackendRoot(): string {
  return resolve(getApiRoot(), "..", "..");
}

/**
 * All invoice PDFs live here: `Backend/Invoices/` at the repo root (not under `apps/api/uploads`).
 * Override with env `INVOICES_STORAGE_DIR` if you need another absolute path.
 */
export function getInvoicesDir(): string {
  const fromEnv = process.env.INVOICES_STORAGE_DIR?.trim();
  const dir = fromEnv ? resolve(fromEnv) : resolve(getBackendRoot(), "Invoices");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Human-readable copies: `Invoices/archive/{invoiceNumber}.pdf`. */
export function getInvoicesArchiveDir(): string {
  const dir = resolve(getInvoicesDir(), "archive");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Color logo next to PDFs: put `logo.png` / `logo.jpg` in `Backend/Invoices/`
 * (or set `INVOICE_LOGO_PATH` in `.env`). First existing file wins.
 */
export function resolveInvoiceLogoPathFromInvoicesDir(): string | undefined {
  const dir = getInvoicesDir();
  const candidates = [
    "color logo.png",
    "color logo.jpg",
    "color logo.jpeg",
    "color logo.webp",
    "color-logo.png",
    "color-logo.jpg",
    "Color Logo.png",
    "Color Logo.jpg",
    "logo.png",
    "logo.jpg",
    "logo.jpeg",
    "logo.webp",
    "jersey-raw-logo.png",
    "jersey-raw-logo.jpg",
    "JR-logo.png",
    "jr-logo.png",
    "photo-jersey-raw-logo.jpg.jpg"
  ];
  for (const name of candidates) {
    const p = resolve(dir, name);
    if (existsSync(p)) return p;
  }
  try {
    const names = readdirSync(dir);
    const hit = names.find((n) => /^color[\s_-]*logo\.(png|jpe?g|webp)$/i.test(n));
    if (hit) return resolve(dir, hit);
  } catch {
    /* ignore */
  }
  return undefined;
}

export function getExpensesUploadDir(): string {
  const dir = resolve(getUploadsRoot(), "expenses");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
