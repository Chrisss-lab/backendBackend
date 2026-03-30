# JRBackEnd

Management Control Hub — owner and high-management back-office system that integrates with separate consumer and worker apps.

## Stack

- API: NestJS + Prisma + **PostgreSQL** (local via `docker-compose.yml`, or Render in production)
- Web: Next.js (management-only UI)
- Shared: common types

## Easiest: one-click start (Windows)

Double-click **`Start.cmd`** (project root).

It creates:

- `apps/api/.env` (database + API secrets — **Prisma reads this folder**)
- `apps/web/.env.local` (optional — leave `NEXT_PUBLIC_API_URL` empty for single-port mode)

It **builds the web** into `apps/web/out`, starts **one Nest process** on port **4000** that serves both the **API** and the **static UI**, then opens **http://localhost:4000**.

For **split development** (hot reload on the Next dev server): run `npm run start:local` — API on :4000 and web on :3001; set `NEXT_PUBLIC_API_URL=http://localhost:4000` in `apps/web/.env.local`.

Database: **PostgreSQL** — see `docker-compose.yml` and `deploy/DEPLOYMENT.md`.

### Minimal runtime footprint

- Runtime source of truth is Google Sheets (Apps Script) for operations data.
- Keep generated folders out of git and local clutter:
  - `apps/web/.next/`
  - `apps/web/out/`
  - `apps/api/dist/`
  - `*.tsbuildinfo`
- For strict no-local file storage, set `STRICT_NO_LOCAL_STORAGE=true` and configure R2 (`R2_*` + `STORAGE_PUBLIC_BASE_URL`) in `apps/api/.env`.

## Manual setup

1. Copy env files:
   - `copy apps\api\.env.example apps\api\.env`
   - `copy apps\web\.env.local.example apps\web\.env.local`
2. Install dependencies:
   - `npm install`
3. Generate Prisma client + apply schema:
   - `npm run prisma:generate -w apps/api`
   - `npm run prisma:db:push -w apps/api`
4. Start (pick one):
   - **One port (matches `Start.cmd`):** `npm run build:web` then `npm run dev:api` → open http://localhost:4000
   - **Two terminals (hot reload UI):** API `npm run dev:api` (:4000) + Web `npm run dev:web` (:3001) with `NEXT_PUBLIC_API_URL=http://localhost:4000` in `apps/web/.env.local`

## API quick routes

- Auth:
  - `POST /auth/seed-owner`
  - `POST /auth/login`
- Integration:
  - `POST /integration/webhook`
  - `GET /integration/reconcile`
- Operations:
  - `GET /operations/dashboard`
  - `POST /operations/expenses`
  - `POST /operations/recipes`
- Reports:
  - `GET /reports/pnl`
  - `GET /reports/expenses.csv`
- Google Phase 2:
  - `GET /integrations/google/status`

## backendBackend

GitHub (backend / monorepo mirror): https://github.com/Chrisss-lab/backendBackend

## Single Google Sheet mode (Apps Script)

A starter controller is included at pps-script/jr-sheet-controller/src/Code.gs to run a single spreadsheet with Expenses, Pending, and Archive plus upload dedupe/no-backlog logic. Setup doc: pps-script/jr-sheet-controller/docs/README.md.

