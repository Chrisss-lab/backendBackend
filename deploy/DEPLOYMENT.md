# Deploy: Cloudflare Pages + Render + R2

This repo is structured for:

| Layer | Platform | Role |
|--------|-----------|------|
| Frontend | [Cloudflare Pages](https://pages.cloudflare.com/) | Static Next.js export from `apps/web` |
| API | [Render](https://render.com/) Web Service | NestJS in `apps/api` |
| Database | Embedded **SQLite** (`apps/api/data/hub.db`) — no separate DB service | Prisma metadata + optional webhook dedup; **orders/expenses/recipes** come from **Google Sheet** when configured |
| Files | [Cloudflare R2](https://developers.cloudflare.com/r2/) | Invoice PDFs and expense receipts (S3-compatible) |

Your **Desktop\Backend BackUps** folder stays a separate, optional archive for old PowerShell backups; production files live in R2 once configured.

## 1. Database (embedded SQLite — no Render Postgres required)

The API uses **Prisma + SQLite** in a file next to the app (`apps/api/data/hub.db`). You **do not** need a separate PostgreSQL instance for a typical **single-site hub** where **Google Sheet** holds orders, expenses, and catalog data.

- **Local:** Omit `DATABASE_URL` in `apps/api/.env` (or set `DATABASE_URL=file:./data/hub.db`). The API creates `apps/api/data/hub.db` on first run. Optional: `docker compose up -d` only if you still use a legacy Postgres URL — the default is SQLite.

- **Apply schema:** `npx prisma migrate deploy --schema apps/api/prisma/schema.prisma` (or `npm run prisma:migrate:deploy -w apps/api`).

- **Seed (optional):** `npm run prisma:seed -w apps/api` — skipped automatically when `HUB_SHEET_ONLY=true`.

- **Single-site + Google Sheet only:** set **`HUB_SHEET_ONLY=true`**, configure **`GOOGLE_SHEET_APPS_SCRIPT_URL`** and **`GOOGLE_SHEET_API_KEY`** (or **`GOOGLE_SHEET_SITE_KEY`**). Sign in via **Google Sheet** session (`/auth/sheet-session`); email/password login and `POST /auth/seed-owner` are disabled. JWT identity uses optional **`SHEET_HUB_JWT_EMAIL`**, **`SHEET_HUB_JWT_SUB`**, **`SHEET_HUB_JWT_ROLE`**.

- **Render:** You **do not** need to add `DATABASE_URL` unless you want a custom path. `npm run render:start` defaults to embedded SQLite before `prisma migrate deploy`.

> **Note:** If you previously used PostgreSQL, switch your `.env` to SQLite (or remove `DATABASE_URL`) and run migrations fresh; there is no automatic Postgres → SQLite data migration.

## 2. API on Render

- **Node version:** Repo includes `.node-version` (`20`) to avoid occasional **npm `ci` segmentation faults** on Node 22. You can also set **`NODE_VERSION=20`** under the Web Service **Environment** if the build still picks 22.
- **Root directory:** repository root (monorepo).
- **Build command** (no DB needed at build time):

  `npm ci && npm run build -w packages/shared && npm run prisma:generate -w apps/api && npm run build -w apps/api && npm run build:web`

- **Start command** (migrations run **inside** `apps/api` so Prisma finds `prisma/` correctly):

  `npm run render:start`

  (`render:start` runs `scripts/render-start.cjs`: Prisma migrate, then Nest — one script so logs and exit codes are reliable on Render.)

- **`JWT_SECRET`:** Required in production (≥ 32 random characters). If the Web Service was **not** created from the repo’s `render.yaml` Blueprint, you must add **`JWT_SECRET` by hand** in **Environment** — the `generateValue` entry in YAML does not apply to manually created services. Use `openssl rand -hex 32` or the `JWT_SECRET` line from `render.env` (generate a fresh secret for production).

- **Legacy PostgreSQL URL:** If you still point `DATABASE_URL` at Postgres, use TLS / URL-encoding as required by your host. The default deployment uses **SQLite** and does not need Render Postgres.

### Prisma **P3009** (“failed migrations … migration … failed”)

That means a **previous** `migrate deploy` was recorded as **failed**. Prisma will not run new migrations until you fix it.

**Fast path (disposable DB):**

1. In the **Web Service** → **Environment**, add: `PRISMA_RESET_PUBLIC_ON_P3009` = `true` (exact string).
2. **Redeploy** — for **SQLite** (default), `render:start` **deletes** `apps/api/data/hub.db` and reapplies migrations. For a legacy **PostgreSQL** `DATABASE_URL`, it runs `scripts/render-reset-public-schema.sql` instead.
3. **Remove** `PRISMA_RESET_PUBLIC_ON_P3009` and redeploy so a future accidental P3009 does not auto-wipe production.

**Manual path (same effect as step 1–2):**

**If this database has no production data you need** (typical for a new Render DB):

1. **Option A — Render’s PSQL command:** On the Postgres **Connections** section, reveal and copy **PSQL Command**, then run it in a terminal on your machine (you need `psql` installed, e.g. from [PostgreSQL downloads](https://www.postgresql.org/download/) or `winget install PostgreSQL.PostgreSQL`).

2. **Option B — Prisma from your laptop (no `psql`):** Copy **External Database URL** from Render (URL-encode special characters in the password). From the **repo root**:

   **PowerShell (Windows):**

   ```powershell
   $env:DATABASE_URL="postgresql://jrbackend_db_user:YOUR_PASSWORD@YOUR_EXTERNAL_HOST:5432/jrbackend_db?sslmode=require"
   npx prisma db execute --schema apps/api/prisma/schema.prisma --file scripts/render-reset-public-schema.sql
   ```

   **bash:**

   ```bash
   export DATABASE_URL="postgresql://..."
   npx prisma db execute --schema apps/api/prisma/schema.prisma --file scripts/render-reset-public-schema.sql
   ```

3. Redeploy the **Web Service** so `render:start` runs a clean `migrate deploy`.

**Alternative (from your laptop, External `DATABASE_URL`):**

```bash
cd apps/api
set DATABASE_URL=postgresql://...external...
npx prisma migrate resolve --rolled-back 20260327180000_init_sqlite
npx prisma migrate deploy
```

If `migrate deploy` then errors with **relation already exists**, use the **DROP SCHEMA** SQL above and redeploy.

**One-shot from repo root (same External URL in env):**

`npm run prisma:migrate:resolve-init-rolled-back -w apps/api` then redeploy; if tables were half-created, still use **DROP SCHEMA** or fix objects manually.

- **Environment variables:**

  - `DATABASE_URL` — Postgres connection string  
  - `JWT_SECRET` — **required in production** (≥ 32 random characters) when the API enforces auth; used to sign session tokens  
  - `PORT` — Render sets this automatically  
  - `CORS_ORIGINS` — **recommended in production:** comma-separated list of allowed browser origins (e.g. `https://your-app.pages.dev,https://yourdomain.com`). If omitted, the API reflects any `Origin` (works but is looser).  
  - `OWNER_SETUP_SECRET` — **required in production** to call `POST /auth/seed-owner` (send same value in header **`X-Setup-Secret`**). In development, seed-owner works without the header.  
  - `INTEGRATION_WEBHOOK_SECRET` — **required in production** for `POST /integration/webhook`; send the same value in **`X-Webhook-Secret`**. In development, optional unless you set the variable (then the header must match).  
  - `API_AUTH_DISABLED` — set to `true` **only** for trusted local automation (disables JWT on API routes). **Never** set on public Render.  
  - `REQUIRE_API_AUTH` — set to `true` to force JWT even when `NODE_ENV` is not `production` (e.g. staging).  
  - `JWT_EXPIRES_IN` — optional token lifetime (default `8h`, e.g. `12h`, `7d`).

**Security model (summary):** In **production**, every JSON API route except `@Public` ones requires a valid **`Authorization: Bearer`** token from `POST /auth/login`. The static **`/uploads/...`** paths (local disk mode) are still served without JWT — prefer **R2** with unguessable object keys for sensitive files, or accept that anyone with the URL can fetch them. The Cloudflare Pages build copies **`apps/web/public/_headers`** for baseline browser security headers.

**R2 (object storage)** — set when you want invoices/receipts off disk:

| Variable | Purpose |
|----------|---------|
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | Bucket name |
| `STORAGE_PUBLIC_BASE_URL` | Public URL for the bucket (custom domain or `https://pub-xxx.r2.dev` style), **no** trailing slash |

If R2 variables are omitted, the API uses **local disk** (`Invoices/`, `uploads/expenses/`) and serves `/uploads/...` as before.

**First production user:** After migrations, create the owner once, then use the Pages sign-in screen:

```bash
curl -sS -X POST "$API_URL/auth/seed-owner" \
  -H "Content-Type: application/json" \
  -H "X-Setup-Secret: $OWNER_SETUP_SECRET" \
  -d '{"email":"you@example.com","password":"your-long-password"}'
```

## 3. Cloudflare R2 bucket

1. Create a bucket and (recommended) a **custom domain** or **r2.dev** public access for reads.  
2. Create R2 **API tokens** with read/write on that bucket.  
3. Put the values in Render env vars above.  
4. `STORAGE_PUBLIC_BASE_URL` must match how browsers load objects (same host as object URLs).

Invoice rows will store **full `https://...` URLs** when R2 is enabled; the web app already treats absolute URLs as-is.

## 4. Frontend on Cloudflare Pages

- **Framework preset:** Next.js (static) or **None** with custom settings.  
- **Root directory:** `/` (repo root — required for npm workspaces).

- **Build command** (from repo root):

  `npm ci && npm run build:web` (skips the API; Pages only needs the static export)

- **Build output directory:** `apps/web/out`

- **Deploy command** (if Cloudflare requires one — do **not** use `npx wrangler deploy`; that targets Workers and errors on monorepo roots):

  `npm run deploy:cf-pages`

- **Environment variables (Pages):**

  | Variable | Example / purpose |
  |----------|-------------------|
  | `NEXT_PUBLIC_API_URL` | `https://your-api.onrender.com` (no trailing slash) |
  | `PAGES_PROJECT_NAME` | Exact **Pages project name** from the dashboard (often matches the subdomain before `.pages.dev`) |

  Without `PAGES_PROJECT_NAME`, `deploy:cf-pages` exits with an error so the log tells you what to set.

No trailing slash on the API URL. After deploy, the SPA calls your Render API for JSON and uses returned invoice/receipt URLs (R2 or API `/uploads/...`).

**Optional single-step build + upload:** `npm ci && npm run build:web && npm run deploy:cf-pages` — then set **Deploy command** to `true` or leave empty if the UI allows it, to avoid uploading twice.

## 5. Local development

1. `docker compose up -d`  
2. `apps/api/.env` with `DATABASE_URL` and optional R2 vars  
3. From root: **`npm run build:web && npm run dev:api`** and open **http://localhost:4000** (one port: Nest serves `apps/web/out` + API), or use **`npm run start:local`** for split dev (web :3001, API :4000).

When `NEXT_PUBLIC_API_URL` is unset, the browser uses **same-origin** (required for single-port). For Cloudflare Pages + remote API, set `NEXT_PUBLIC_API_URL` to your deployed API URL.

## 6. Legacy backups (`Desktop\Backend BackUps`)

PowerShell scripts under `scripts/` were built for SQLite + local `Invoices/`. With Postgres + R2, use **database dumps** (Render Postgres backups or `pg_dump`) and R2 lifecycle rules for retention instead of moving PDFs off a single laptop disk.

## Optional: Single-sheet Google Apps Script controller

If you want one spreadsheet (Expenses, Pending, Archive) as your operational source, use the template in pps-script/jr-sheet-controller/src/Code.gs.

Set script properties:
- API_KEY`n- INVOICES_FOLDER_ID = 1eTvPeZ8tYxO06TCGrebpJFS6J6L5fAD4`n- RECEIPTS_FOLDER_ID = 1DnA91fLhXmbQoHoWx8OyKarpM8QKLjGc`n- UPLOADS_START_AT_ISO (blocks historical backlog uploads; only new uploads after this timestamp are accepted).

