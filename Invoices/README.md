# Invoice PDF storage

All generated invoice PDFs are saved **here** (`Backend/Invoices/` at the monorepo root), not under `apps/api/uploads/`.

| Location | Contents |
|----------|-----------|
| This folder | One PDF per invoice: `{database-invoice-id}.pdf` (URLs: `/uploads/invoices/...`) |
| `archive/` | Extra copy named `{invoiceNumber}.pdf` for easy browsing |

## One-time full sync on API start (pending + archive + regenerate all PDFs)

On the **first** API boot after this feature ships, if the stamp file **`.jr-pending-archive-full-sync.done`** is not present in this folder, the server runs the same work as **Sync pending + archive & rebuild ALL invoice PDFs**, then writes that stamp so it does **not** run again on every restart.

- **Run again once:** delete `.jr-pending-archive-full-sync.done` from `Invoices/` and restart the API.
- **Run on every boot:** set `INVOICE_FORCE_FULL_SYNC_ON_START=true` in `apps/api/.env` (heavy — use only if you need it).

The web app also calls **`sync-pending`** when you open **Pending Orders** and **`sync-archive`** when you open **Archive Orders**, so day-to-day gaps fill in without buttons.

## Color logo on PDFs

Put your logo in this folder using one of these names (first match wins):

**`color logo.png`** / **`color logo.jpg`** (with a space) · `color-logo.png` · `logo.png` · `logo.jpg` · `logo.webp` · `jersey-raw-logo.png` · `JR-logo.png`

Or set **`INVOICE_LOGO_PATH`** in `apps/api/.env` to an absolute path.

After adding or changing the logo, open the app **Invoices** tab and click **Sync pending + archive & rebuild ALL invoice PDFs** (or `POST /operations/invoices/sync-all-and-regenerate`). That creates any missing invoices for pending + archive orders, then rebuilds every PDF. For PDF-only refresh: **PDFs only** or `POST /operations/invoices/regenerate-all`.

The demo sample is **`DEMO-sample-invoice.pdf`** (recreated when the API starts and after a full regenerate).

If you used an older build that wrote under `apps/api/uploads/invoices/`, move any PDFs you still need into this folder (or set `INVOICES_STORAGE_DIR` in `apps/api/.env` to point elsewhere).
