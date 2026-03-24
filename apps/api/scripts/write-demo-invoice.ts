/**
 * Bootstraps the API context once so `OperationsService.onModuleInit` writes DEMO-sample-invoice.pdf.
 * Run: npm run invoice:demo -w apps/api
 */
import { existsSync } from "fs";
import { resolve } from "path";
import { config as loadEnv } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/modules/app.module";
import { getInvoicesDir } from "../src/paths";
import { join } from "path";

function loadApiEnv() {
  const apiRoot = resolve(__dirname, "..");
  const candidates = [resolve(apiRoot, ".env"), resolve(apiRoot, "..", "..", ".env"), resolve(process.cwd(), ".env")];
  for (const p of candidates) {
    if (existsSync(p)) {
      loadEnv({ path: p });
      break;
    }
  }
  const dbPath = resolve(apiRoot, "prisma", "dev.db");
  process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, "/")}`;
}

async function main() {
  loadApiEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  await app.close();
  const p = join(getInvoicesDir(), "DEMO-sample-invoice.pdf");
  const port = process.env.PORT || "4000";
  // eslint-disable-next-line no-console
  console.log("Demo invoice:", p);
  // eslint-disable-next-line no-console
  console.log("When the API is running, open: http://localhost:" + port + "/uploads/invoices/DEMO-sample-invoice.pdf");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
