import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as express from "express";
import { existsSync } from "fs";
import { resolve } from "path";
import { getInvoicesDir, getUploadsRoot } from "./paths";
import { StorageService } from "./storage/storage.service";
import { config as loadEnvFile } from "dotenv";
import { AppModule } from "./modules/app.module";

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
if (!process.env.DATABASE_URL?.trim()) {
  // eslint-disable-next-line no-console
  console.warn(
    "[api] DATABASE_URL is not set. Use PostgreSQL (see docker-compose.yml and deploy/DEPLOYMENT.md). Example: postgresql://postgres:postgres@localhost:5432/hub"
  );
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const uploadsDir = getUploadsRoot();
  const storage = app.get(StorageService);
  /** Local disk only: invoice PDFs in `Backend/Invoices/`, receipts in `uploads/`. R2 uses public URLs in DB. */
  if (!storage.usesObjectStorage()) {
    app.use("/uploads/invoices", express.static(getInvoicesDir()));
    app.use("/uploads", express.static(uploadsDir));
  }
  app.enableCors({ origin: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.PORT) || 4000;
  await app.listen(port, "0.0.0.0");
  // eslint-disable-next-line no-console
  // eslint-disable-next-line no-console
  console.log(`[api] Listening on 0.0.0.0:${port}`);
  // eslint-disable-next-line no-console
  console.log(
    storage.usesObjectStorage() ? "[api] Invoice/receipt storage: R2 (no local /uploads static)" : `[api] Invoice PDFs folder: ${getInvoicesDir()}`
  );
}

void bootstrap();
