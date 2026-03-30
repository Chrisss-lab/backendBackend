# JR Single-Sheet Controller (Google Apps Script)

This folder contains a Google Apps Script Web App to run your management data from **one spreadsheet** with tabs:

- `Expenses`
- `Pending`
- `Archive`
- `Customers`
- `Products`
- `Ingredients`
- `Inventory`
- `Payments`
- `Settings`
- `AuditLog`

And helper tabs:

- `UploadsLedger` (dedupe + audit for invoice/receipt uploads)
- `Config` (optional key/value settings)

## Drive folders (provided)

- Invoices: `1eTvPeZ8tYxO06TCGrebpJFS6J6L5fAD4`
- Receipts: `1DnA91fLhXmbQoHoWx8OyKarpM8QKLjGc`

Set these in Apps Script **Script Properties**:

- `INVOICES_FOLDER_ID`
- `RECEIPTS_FOLDER_ID`
- `API_KEY` (master key)

Optional per-website keys (so each site has its own secret):

- In tab `Config`, add rows like:
  - `SITE_KEY:storefront-a` => `your-secret-a`
  - `SITE_KEY:partner-b` => `your-secret-b`

Then those sites can send `siteKey` instead of the master `apiKey`.

## No-backlog upload rule (new files only)

Set `UPLOADS_START_AT_ISO` in Script Properties, for example:

`2026-03-25T00:00:00-04:00`

Any `uploadInvoice` / `uploadReceipt` call with `eventAt` older than this timestamp is ignored.

## API contract (Web App)

### GET

- `?action=health`
- `?action=pull&since=2026-03-25T00:00:00Z&apiKey=...`
- `?action=summary&apiKey=...`
- `?action=totals&apiKey=...` (reads **`Calculator`** tab only — run `JR_createCalculatorSheet()` once; see [CALCULATOR_SHEET.md](./CALCULATOR_SHEET.md))
- `?action=checkPages&apiKey=...` (verifies tabs + headers are up to date)

### POST JSON body

- `{"action":"upsertExpense", ... , "apiKey":"..."}`
- `{"action":"upsertPending", ... , "apiKey":"..."}`
- `{"action":"submitOrder", "customerName":"...", "items":[{"productId":"...","productName":"Daily Thrive","quantity":25,"quantityUnit":"lb"}], "apiKey":"..."}`
- `{"action":"upsertArchive", ... , "apiKey":"..."}`
- `{"action":"upsertCustomer", ... , "apiKey":"..."}`
- `{"action":"upsertProduct", ... , "apiKey":"..."}`
- `{"action":"upsertIngredient", ... , "apiKey":"..."}`
- `{"action":"setProductIngredients", "productId":"...", "productName":"...", "lines":[{"ingredientName":"Chicken","ratioPercent":72}], "apiKey":"..."}`
- `{"action":"recalcProducts", "apiKey":"..."}`
- `{"action":"applyProductFormulas", "apiKey":"..."}`
- `{"action":"upsertInventory", "ingredientId":"...","ingredientName":"Chicken","quantityOnHand":120,"unitCost":2.35,"receivedAt":"...","notes":"...", "apiKey":"..."}`
- `{"action":"addInventory", "ingredientId":"...","ingredientName":"Chicken","addQuantity":25,"unitCost":2.50,"notes":"restock", "apiKey":"..."}`
- `{"action":"upsertPayment", ... , "apiKey":"..."}`
- `{"action":"recordPayment", "orderId":"...","invoiceNumber":"...","amount":120.5,"paymentMethod":"Zelle","status":"PAID","apiKey":"..."}`
- `{"action":"setSetting", "key":"NJ_TAX_RATE", "value":"0.06625", "apiKey":"..."}`
- `{"action":"movePendingToArchive", "id":"...", "apiKey":"..."}`
- `{"action":"uploadInvoice", "rowId":"...", "base64Data":"...", "fileName":"...", "eventAt":"...", "sha256":"...", "apiKey":"..."}`
- `{"action":"uploadReceipt", ... }`
- `{"action":"bulkUpsert", "expenses":[...], "pending":[...], "archive":[...], "apiKey":"..."}`
- `{"action":"bulkUpload", "files":[{"kind":"invoice"| "receipt", ...}], "apiKey":"..."}`

For external sites, you can replace `apiKey` with `siteKey` if configured in `Config`.

### Multi-item order submit (recommended for websites)

Use `submitOrder` for one customer with multiple products/items in one order.  
The API:

- stores one row in `Pending`
- calculates subtotal from `Products.price` (or `unitPrice` you pass)
- stores line items in `orderItemsJson`

When `movePendingToArchive` runs, inventory is auto-deducted from `Inventory` using each product's ingredient ratios from the `Products` dynamic ingredient columns.

### Suggested `Settings` keys

- `NJ_TAX_RATE` -> `0.06625`
- `INVOICE_PREFIX` -> `JR`
- `UPLOADS_START_AT_ISO` -> `2026-03-25T00:00:00-04:00` (if you also want this mirrored in the sheet)
- `DEFAULT_CURRENCY` -> `USD`

## Suggested extra tabs (recommended)

Beyond your 3 tabs, add these to keep operations clean:

- `Customers` - stable phone/email identity and dedupe
- `Products` - recipe/sku pricing snapshots + recipe-page fields (`description`, `foodType`, `chargeUnit`, `amountPerUnit`, `isBundle`) + dynamic ingredient columns (`ingredient 1`, `ingredient 1 ratio`, `ingredient 2`, `ingredient 2 ratio`, ... no fixed limit)
- `Products` formula behavior: `costPerLb` and `ingredientCount` are written as spreadsheet formulas so changes to ingredient names/ratios or ingredient costs update immediately in-sheet.
- `Ingredients` - ingredient master list with default cost and sale charge + usage columns (`usedInProducts`, `usedInProductsCount`, `avgRatioPercent`)
- `Inventory` - current stock/lot snapshots by ingredient
- `Payments` - invoice payment events and method
- `Settings` - NJ tax rate, invoice prefix, upload cutoff
- `AuditLog` - write-once action log (`who`, `when`, `action`, `rowId`)

## Security

- Use a strong `API_KEY` script property.
- Restrict deployment access if possible.
- Keep Drive folders private and share only with required users/service account.
