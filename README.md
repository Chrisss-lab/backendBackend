# JRBackEnd

Management Control Hub — owner and high-management back-office system that integrates with separate consumer and worker apps.

## Stack

- API: NestJS + Prisma + **PostgreSQL** (local via `docker-compose.yml`, or Render in production)
- Web: Next.js (management-only UI)
- Shared: common types

## Easiest: one-click start (Windows)

Double-click **`Backend Start.bat`**.

It creates:

- `apps/api/.env` (database + API secrets — **Prisma reads this folder**)
- `apps/web/.env.local` (API URL for the browser)

It starts **API + Web together** in one window (`npm run start:local`), waits until port **3001** is open, then opens your browser.

Database: **PostgreSQL** — see `docker-compose.yml` and `deploy/DEPLOYMENT.md`.

### What uses disk space

| Path | Purpose |
|------|--------|
| `node_modules/` | Dependencies (~1 GB). Safe to delete; run `npm install` again. |
| `apps/web/.next/` | Next.js build cache. Safe to delete; rebuilt on `npm run dev` / `build`. |
| `apps/api/dist/` | Compiled API (if present). Rebuilt with `nest build`. |
| `Invoices/` | **Real invoice PDFs** — keep unless you have another backup. |
| `apps/api/uploads/expenses/` | **Receipt files** attached to expenses in the app — keep. |

Legacy one-off import folders **`Orders/`** (Excel sources) and **`Receipts/`** (extracted uploads + sheet) are **not** required for day-to-day use and were removed to save space. To run `scripts/import-orders-from-docs.js`, `map-receipts-from-sheet.js`, etc., restore those folders from backup.

### Weekly backup (Desktop `Backend BackUps`)

- Folder: **`%USERPROFILE%\Desktop\Backend BackUps`** (created automatically).
- **Default behavior:** backup **invoice PDFs for archived orders only** (not pending), **expense uploads**, and a **`dev.db` snapshot**, then **remove** those PDFs and receipt files from the live project to **save disk space**. The live **`dev.db` is never deleted** — orders stay searchable.
- **Manual:** double-click **`scripts\Weekly-Backup.cmd`**.
- **Copy only (no delete):** `.\scripts\backup-media-weekly.ps1 -CopyOnly`
- **Monthly schedule (1st of month, 3:00 AM):** `powershell -ExecutionPolicy Bypass -File .\scripts\register-monthly-backup-task.ps1`  
  Task: **ManagementHub-MonthlyMediaBackup** (removes legacy **ManagementHub-WeeklyMediaBackup** if it exists).  
  After move, **Preview PDF** / receipt links need files copied back from the latest `run_*` folder (or restore before viewing).  
  After each backup, **`dedupe-backups.ps1`** runs in `Backend BackUps` (same content = one copy kept, newest `run_*` wins). Log: **`dedupe-log.txt`**.  
  Details: **`Desktop\Backend BackUps\README.md`**.

## Manual setup

1. Copy env files:
   - `copy apps\api\.env.example apps\api\.env`
   - `copy apps\web\.env.local.example apps\web\.env.local`
2. Install dependencies:
   - `npm install`
3. Generate Prisma client + apply schema:
   - `npm run prisma:generate -w apps/api`
   - `npm run prisma:db:push -w apps/api`
4. Start apps (two terminals):
   - API: `npm run dev:api` → http://localhost:4000
   - Web: `npm run dev:web` → http://localhost:3001

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
