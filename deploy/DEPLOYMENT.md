# Deploy: Cloudflare Pages + Render + R2

This repo is structured for:

| Layer | Platform | Role |
|--------|-----------|------|
| Frontend | [Cloudflare Pages](https://pages.cloudflare.com/) | Static Next.js export from `apps/web` |
| API | [Render](https://render.com/) Web Service | NestJS in `apps/api` |
| Database | Render PostgreSQL (or any Postgres URL) | Prisma `provider = postgresql` |
| Files | [Cloudflare R2](https://developers.cloudflare.com/r2/) | Invoice PDFs and expense receipts (S3-compatible) |

Your **Desktop\Backend BackUps** folder stays a separate, optional archive for old PowerShell backups; production files live in R2 once configured.

## 1. Database (local and Render)

- **Local:** `docker compose up -d` in the repo root, then set in `apps/api/.env`:

  `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hub?schema=public`

- **Apply schema:** from repo root:

  `npx prisma migrate deploy --schema apps/api/prisma/schema.prisma`

  For first-time dev with migrations: `npm run prisma:migrate -w apps/api` (creates DB from migrations).

- **Seed (optional):** `npm run prisma:seed -w apps/api`

- **Render:** Create a PostgreSQL instance, copy its **Internal Database URL** into the Web Service as `DATABASE_URL`. The `render.yaml` blueprint wires this if you use Blueprint deploy.

> **Note:** The app previously used SQLite (`dev.db`). There is no automatic data migration; export/import manually if you need old rows.

## 2. API on Render

- **Node version:** Repo includes `.node-version` (`20`) to avoid occasional **npm `ci` segmentation faults** on Node 22. You can also set **`NODE_VERSION=20`** under the Web Service **Environment** if the build still picks 22.
- **Root directory:** repository root (monorepo).
- **Build command** (no DB needed at build time):

  `npm ci && npm run build -w packages/shared && npm run prisma:generate -w apps/api && npm run build -w apps/api`

- **Start command** (runs migrations, then API — **requires `DATABASE_URL`** at runtime):

  `npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && node apps/api/dist/main.js`

- **PostgreSQL:** Create a Render **PostgreSQL** instance, then in the Web Service → **Environment** add **`DATABASE_URL`** (use **Internal Database URL** when API and DB are in the same region). Redeploy after adding it. Without this, the **build** can still succeed, but the service will **fail on start** when migrations run.

- **Environment variables:**

  - `DATABASE_URL` — Postgres connection string  
  - `JWT_SECRET` — strong random string  
  - `PORT` — Render sets this automatically  

**R2 (object storage)** — set when you want invoices/receipts off disk:

| Variable | Purpose |
|----------|---------|
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | Bucket name |
| `STORAGE_PUBLIC_BASE_URL` | Public URL for the bucket (custom domain or `https://pub-xxx.r2.dev` style), **no** trailing slash |

If R2 variables are omitted, the API uses **local disk** (`Invoices/`, `uploads/expenses/`) and serves `/uploads/...` as before.

**CORS:** The API uses `origin: true`, so your Pages domain is allowed once the browser calls the Render URL.

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
3. From root: `npm run start:local` or run API and web workspaces separately  

Web default API URL remains `http://localhost:4000` when `NEXT_PUBLIC_API_URL` is unset.

## 6. Legacy backups (`Desktop\Backend BackUps`)

PowerShell scripts under `scripts/` were built for SQLite + local `Invoices/`. With Postgres + R2, use **database dumps** (Render Postgres backups or `pg_dump`) and R2 lifecycle rules for retention instead of moving PDFs off a single laptop disk.
