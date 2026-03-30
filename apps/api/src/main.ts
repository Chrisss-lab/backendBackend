import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { existsSync, mkdirSync } from "fs";
import helmet from "helmet";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { StorageService } from "./storage/storage.service";
import { config as loadEnvFile } from "dotenv";
import { assertProductionJwtSecret } from "./modules/auth/auth-security.util";
import { AppModule } from "./modules/app.module";
import { resolveWebOutDir } from "./hub-static-path";
import { isHubSheetOnly } from "./hub-mode";

/**
 * When started from the monorepo root, cwd may not be apps/api — then Nest would miss .env
 * and Prisma would not get DATABASE_URL. Load .env explicitly from known locations.
 */
function loadLocalEnv() {
  const candidates = [
    resolve(process.cwd(), "apps", "api", ".env"),
    resolve(process.cwd(), ".env"),
    resolve(__dirname, "..", ".env")
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      loadEnvFile({ path: p });
      // eslint-disable-next-line no-console
      console.log(`[api] Loaded environment from: ${p}`);
      return;
    }
  }
  // eslint-disable-next-line no-console
  console.warn("[api] No .env file found in apps/api or cwd — using process.env only.");
}

loadLocalEnv();

function exitIfPostgresUrlWithSqliteSchema() {
  const u = process.env.DATABASE_URL?.trim() ?? "";
  if (u && /^(postgresql|postgres):\/\//i.test(u)) {
    // eslint-disable-next-line no-console
    console.error(
      "[api] DATABASE_URL is PostgreSQL, but this build uses SQLite. Remove DATABASE_URL in Render (embedded DB) or point at a file: URL."
    );
    process.exit(1);
  }
}

/** Embedded SQLite next to the API (no separate Postgres service). Path is stable when cwd is repo root or apps/api. */
function ensureDefaultSqliteDatabaseUrl() {
  exitIfPostgresUrlWithSqliteSchema();
  if (process.env.DATABASE_URL?.trim()) return;
  const dataDir = join(__dirname, "..", "data");
  mkdirSync(dataDir, { recursive: true });
  const dbFile = join(dataDir, "hub.db");
  process.env.DATABASE_URL = pathToFileURL(dbFile).href;
  // eslint-disable-next-line no-console
  console.log(`[api] DATABASE_URL not set — using embedded SQLite: ${dbFile}`);
}

ensureDefaultSqliteDatabaseUrl();

async function bootstrap() {
  assertProductionJwtSecret();
  if (isHubSheetOnly() && !String(process.env.GOOGLE_SHEET_APPS_SCRIPT_URL ?? "").trim()) {
    // eslint-disable-next-line no-console
    console.warn("[api] HUB_SHEET_ONLY is set but GOOGLE_SHEET_APPS_SCRIPT_URL is missing — configure Apps Script URL.");
  }
  const app = await NestFactory.create(AppModule);
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set("trust proxy", 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: false
    })
  );

  const storage = app.get(StorageService);

  const allowlist = process.env.CORS_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const corsCommon = {
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Setup-Secret", "X-Webhook-Secret"]
  };
  if (allowlist && allowlist.length > 0) {
    app.enableCors({ ...corsCommon, origin: allowlist });
  } else {
    app.enableCors({ ...corsCommon, origin: true });
    if (process.env.NODE_ENV === "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[api] Set CORS_ORIGINS (comma-separated) to your Cloudflare Pages / app origins for stricter CORS."
      );
    }
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true
    })
  );
  const port = Number(process.env.PORT) || 4000;
  await app.listen(port, "0.0.0.0");
  const webOut = resolveWebOutDir();
  // eslint-disable-next-line no-console
  // eslint-disable-next-line no-console
  console.log(`[api] Listening on 0.0.0.0:${port}`);
  if (webOut) {
    // eslint-disable-next-line no-console
    console.log(`[api] Web UI (static): ${webOut} → http://localhost:${port}/`);
  }
  // eslint-disable-next-line no-console
  console.log(
    storage.usesObjectStorage()
      ? "[api] Invoice/receipt storage: object storage"
      : "[api] Invoice/receipt storage: local fallback (set STRICT_NO_LOCAL_STORAGE=true to disable)"
  );
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[api] Bootstrap failed:", err);
  process.exit(1);
});
