export function normalizeRecipeRatioPercent(raw: unknown): number {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return 0;
    const hasPercentSign = s.includes("%");
    const numeric = Number(s.replace(/%/g, "").trim());
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    if (hasPercentSign) return numeric;
    return numeric < 0.01 ? numeric * 100 : numeric;
  }
  const n = Number(raw || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 0.01 ? n * 100 : n;
}

export function formatRecipeRatioForInput(raw: unknown): string {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n) < 1e-12) return "0";
  return n.toFixed(6).replace(/\.?0+$/, "");
}

export function parseRecipeRatioInput(raw: unknown): number {
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  const n = Number(s.replace(/%/g, "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}
