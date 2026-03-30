/**
 * Render start: prisma migrate deploy, then Nest API (one process chain, logs visible).
 * @see deploy/DEPLOYMENT.md
 */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

const repoRoot = path.resolve(__dirname, "..");
const apiDir = path.join(repoRoot, "apps", "api");
const mainJs = path.join(apiDir, "dist", "main.js");
const resetSql = path.join(repoRoot, "scripts", "render-reset-public-schema.sql");

function log(...args) {
  console.error("[render:start]", ...args);
}

function assertSqliteNotPostgresUrl() {
  const u = String(process.env.DATABASE_URL || "").trim();
  if (u && /^(postgresql|postgres):\/\//i.test(u)) {
    log(
      "DATABASE_URL is PostgreSQL but this app expects SQLite. In Render → Environment, delete DATABASE_URL (use embedded DB)."
    );
    process.exit(1);
  }
}

function ensureDefaultDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return;
  const dataDir = path.join(apiDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, "hub.db");
  process.env.DATABASE_URL = pathToFileURL(dbFile).href;
  log("Using embedded SQLite:", dbFile);
}

function isSqliteFileUrl() {
  return String(process.env.DATABASE_URL || "").trim().startsWith("file:");
}

function sqliteFilePath() {
  const u = String(process.env.DATABASE_URL || "").trim();
  if (!u.startsWith("file:")) return null;
  try {
    return fileURLToPath(u);
  } catch {
    return null;
  }
}

function prismaBinPath() {
  const candidates = [
    path.join(repoRoot, "node_modules", ".bin", "prisma"),
    path.join(apiDir, "node_modules", ".bin", "prisma")
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runNpm(args, inherit) {
  const opts = {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
    stdio: inherit ? "inherit" : "pipe"
  };
  if (!inherit) opts.encoding = "utf8";
  return spawnSync("npm", args, opts);
}

/** Prefer local prisma CLI (reliable on Render); fall back to npm workspace. */
function migrateDeployCapture() {
  const bin = prismaBinPath();
  if (bin) {
    const direct = spawnSync(bin, ["migrate", "deploy"], {
      cwd: apiDir,
      env: process.env,
      stdio: "pipe",
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      shell: false
    });
    if (direct.status === 0) return direct;
    flushLog((direct.stdout || "") + (direct.stderr || ""));
    log("prisma migrate deploy (direct) exit=", direct.status, "— retrying via npm -w apps/api …");
  }
  return runNpm(["run", "prisma:migrate:deploy", "-w", "apps/api"], false);
}

function dbExecutePostgresReset() {
  return runNpm(
    ["exec", "-w", "apps/api", "--", "prisma", "db", "execute", "--schema", "prisma/schema.prisma", "--file", resetSql],
    false
  );
}

function flushLog(text) {
  if (!text) return;
  process.stderr.write(text);
  if (!text.endsWith("\n")) process.stderr.write("\n");
}

function doMigrateWithRecovery() {
  let r = migrateDeployCapture();
  let out = (r.stdout || "") + (r.stderr || "");
  flushLog(out);
  if (r.error) {
    log("npm spawn error:", r.error.message);
    process.exit(1);
  }
  if (r.status === 0) return;

  if (out.includes("P3009") && process.env.PRISMA_RESET_PUBLIC_ON_P3009 === "true") {
    log("P3009 recovery requested…");
    if (isSqliteFileUrl()) {
      const fp = sqliteFilePath();
      if (fp) {
        try {
          fs.unlinkSync(fp);
          log("Removed SQLite DB:", fp);
        } catch (e) {
          log("Could not remove SQLite:", e.message);
        }
      }
    } else {
      const r2 = dbExecutePostgresReset();
      flushLog((r2.stdout || "") + (r2.stderr || ""));
      if (r2.status !== 0) process.exit(r2.status || 1);
    }
    r = migrateDeployCapture();
    out = (r.stdout || "") + (r.stderr || "");
    flushLog(out);
  }

  if (r.status !== 0) {
    log("Prisma migrate deploy failed, exit", r.status);
    process.exit(r.status || 1);
  }
}

function apiAuthDisabled() {
  const v = String(process.env.API_AUTH_DISABLED || "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function jwtAuthEnforced() {
  if (apiAuthDisabled()) return false;
  if (process.env.REQUIRE_API_AUTH === "true" || process.env.REQUIRE_API_AUTH === "1") return true;
  return process.env.NODE_ENV === "production";
}

/** Same rules as apps/api assertProductionJwtSecret — fail here with Render-specific hints. */
function assertJwtSecretBeforeApi() {
  if (!jwtAuthEnforced()) return;
  const s = String(process.env.JWT_SECRET || "").trim();
  if (s.length >= 32) return;
  log("JWT_SECRET is missing or shorter than 32 characters (required when NODE_ENV=production).");
  log("Render → Web Service → Environment → Add Environment Variable:");
  log("  Name: JWT_SECRET");
  log("  Value: any random string ≥32 characters (e.g. run: openssl rand -hex 32)");
  log("Or paste the JWT_SECRET line from render.env in the repo (use a fresh secret in production).");
  log("Note: render.yaml generateValue only applies if the service is created from that Blueprint; manual services need JWT_SECRET added by hand.");
  process.exit(1);
}

function runApi() {
  assertJwtSecretBeforeApi();
  if (!fs.existsSync(mainJs)) {
    log("Missing", mainJs, "— build step must run nest build for apps/api");
    process.exit(1);
  }
  log("Starting API:", mainJs);
  const api = spawnSync(process.execPath, [mainJs], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: false
  });
  if (api.error) {
    log("node spawn error:", api.error.message);
    process.exit(1);
  }
  process.exit(api.status === 0 ? 0 : api.status || 1);
}

log("repoRoot=", repoRoot, "node=", process.version);
assertSqliteNotPostgresUrl();
ensureDefaultDatabaseUrl();
doMigrateWithRecovery();
runApi();
