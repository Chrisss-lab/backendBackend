/**
 * Used by backup-media-weekly.ps1: lists invoices whose orders are archived only
 * (FULFILLED / CANCELLED). Pending (NEW / CONFIRMED) invoices stay on disk.
 *
 * Run from repo with cwd = apps/api (so Prisma resolves schema + DATABASE_URL):
 *   cd apps/api && npx ts-node --transpile-only ../../scripts/list-archived-invoice-entries.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
import { PrismaClient, OrderStatus } from "@prisma/client";

const apiRoot = resolve(__dirname, "../apps/api");
config({ path: resolve(apiRoot, ".env") });

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.invoice.findMany({
      where: {
        order: {
          status: { in: [OrderStatus.FULFILLED, OrderStatus.CANCELLED] }
        }
      },
      select: { id: true, invoiceNumber: true }
    });
    process.stdout.write(JSON.stringify({ entries: rows }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
