/**
 * Hub sign-in is enforced unless you explicitly skip it (local tooling only).
 * Set NEXT_PUBLIC_SKIP_HUB_LOGIN=1 to open the site without /login (not for production).
 */
function hubAuthSkippable(): boolean {
  const v = (process.env.NEXT_PUBLIC_SKIP_HUB_LOGIN ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function hubAuthEnforced(): boolean {
  return !hubAuthSkippable();
}
