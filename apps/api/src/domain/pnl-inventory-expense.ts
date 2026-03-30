/**
 * Expense rows in these categories are ingredient / packaging purchases.
 * Order COGS already reflects product cost/lb, so these must not also flow through
 * operating expense on the P&amp;L (Calculator `PNL_INVENTORY_EXPENSE_CATEGORIES` matches).
 */

const INVENTORY_CANONICAL = new Set(
  [
    "meats",
    "poultry",
    "seafood",
    "fish",
    "organs",
    "dairy",
    "fruits/veggies",
    "fats",
    "supplements",
    "packaging"
  ]
);

/**
 * Normalize free-text sheet categories so minor spelling / spacing / singular forms
 * still classify as inventory (avoid double-counting food spend as operating).
 */
export function normalizeExpenseCategoryForPnl(raw: unknown): string {
  let s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!s) return "";
  s = s.replace(/\s*\/\s*/g, "/");
  const alias: Record<string, string> = {
    meat: "meats",
    organ: "organs",
    supplement: "supplements",
    "fruits and veggies": "fruits/veggies",
    "fruits & veggies": "fruits/veggies",
    "fruit/veggies": "fruits/veggies",
    "fruits/vegetables": "fruits/veggies",
    "fruit and vegetables": "fruits/veggies"
  };
  if (alias[s]) s = alias[s];
  return s;
}

export function isPnlInventoryPurchaseExpenseCategory(raw: unknown): boolean {
  const k = normalizeExpenseCategoryForPnl(raw);
  return k.length > 0 && INVENTORY_CANONICAL.has(k);
}
