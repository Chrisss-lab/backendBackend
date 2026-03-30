# Calculator tab (Sheet-native formulas)

Financial rollups live in a **`Calculator`** tab as normal Google Sheets formulas (SUMIFS over `Pending`, `Archive`, `Expenses`, etc.). That gives you:

- A visible “audit trail” you can inspect and extend in-grid.
- A cheap API path that **does not scan every row into JSON** (`action=totals`).

## One-time setup

1. Open the spreadsheet bound to **jr-sheet-controller** (the project where `Code.gs` lives).
2. In Apps Script, open `Calculator.gs` (or paste its contents into the bound project).
3. Select **`JR_createCalculatorSheet`** in the function dropdown → **Run**.
4. Authorize when prompted. A **`Calculator`** tab appears with columns:
   - **A** — stable keys (e.g. `order_net_sales`, `net_profit_pnl`)
   - **B** — formulas
   - **C** — description

Re-run **`JR_createCalculatorSheet()`** after you change headers on `Pending`, `Archive`, or `Expenses` so column letters stay correct.

## Main Web App: read totals only

Same deployment URL as today; add:

`GET ...?action=totals&siteKey=...`  
(use `apiKey=...` if you use the master key)

Response shape:

```json
{
  "ok": true,
  "totals": {
    "nj_tax_rate": 0.06625,
    "order_revenue_tax_incl": 12345.67,
    "order_net_sales": 11589.12,
    "order_gross_profit": 8000,
    "order_cogs": 3589.12,
    "expense_total_all": 2000,
    "expense_inventory_purchases": 500,
    "expense_operating_pnl": 1500,
    "net_profit_pnl": 6500,
    "orders_active_count": 42,
    "orders_cancelled_count": 3,
    "payments_paid_record_count": 10,
    "calculator_schema_version": 1
  },
  "now": "2026-03-26T12:00:00.000Z"
}
```

Notes:

- **`action=totals`** skips `ensureSchema_()` in `doGet` so it stays fast and read-only.
- Your Nest app can call this URL for headline P&amp;L numbers while still using `pull` when you need full row payloads.

## Optional second deployment (totals-only project)

If you want a **separate** Web App with **no** `pull`, `upsert`, or other POST actions:

1. Create a **new** Apps Script project (standalone is fine).
2. Paste **`TotalsOnlyWebApp.gs`** as the only `Code.gs`.
3. Set Script properties: `SPREADSHEET_ID`, `API_KEY`.
4. Deploy as Web App; call `?action=totals&apiKey=...`.

That script only opens the spreadsheet and reads `Calculator!A:B`.

## What the formulas mirror

Roughly aligned with the Nest “sheet P&amp;L” split:

- **Active orders** — `status <> CANCELLED` on both `Pending` and `Archive`.
- **Net sales** — sum of `preTaxNet`.
- **Gross profit** — sum of stored `profit` (from sheet/controller economics).
- **Implied COGS** — `order_net_sales - order_gross_profit`.
- **Operating expenses** — total expenses minus inventory-style categories (Meats, Organs, Dairy, etc.).
- **Net profit** — `order_gross_profit - expense_operating_pnl`.

Extend the tab with more rows (e.g. date-windowed SUMIFS) and they will appear in `totals` as long as column **A** stays a snake_case key matching `/^[a-z][a-z0-9_]*$/`.
