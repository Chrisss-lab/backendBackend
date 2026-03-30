import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { OrderStatus, PrismaClient, Role } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const apiRoot = resolve(__dirname, "..");

const DEMO_OWNER_EMAIL = "owner@local.test";
const DEMO_OWNER_PASSWORD = "demo-owner-12";

async function main() {
  if (process.env.HUB_SHEET_ONLY === "true") {
    console.log("[seed-if-empty] HUB_SHEET_ONLY — skipping Prisma demo seed (orders/expenses/recipes live in Google Sheet).");
    await prisma.$disconnect();
    return;
  }

  const ingCount = await prisma.ingredient.count();
  if (ingCount === 0) {
    console.log("[seed-if-empty] No ingredients — prisma:seed + prisma:import:recipes …");
    const sh = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    execSync("npm run prisma:seed", { cwd: apiRoot, stdio: "inherit", env: process.env, shell: sh });
    execSync("npm run prisma:import:recipes", { cwd: apiRoot, stdio: "inherit", env: process.env, shell: sh });
  } else {
    console.log(`[seed-if-empty] Ingredients already present (${ingCount}); skipping catalog seed.`);
  }

  const custCount = await prisma.customer.count();
  if (custCount === 0) {
    console.log("[seed-if-empty] No customers — creating demo customer …");
    await prisma.customer.create({
      data: {
        name: "Demo Customer",
        email: "demo@jerseyraw.example",
        phone: "973-555-0100",
        externalId: "demo-local-customer"
      }
    });
  }

  const orderCount = await prisma.order.count();
  if (orderCount === 0) {
    const customer = await prisma.customer.findFirst();
    if (customer) {
      const recipe = await prisma.recipe.findFirst();
      const demoPreTax = 187.5;
      const subtotalIncl = Number((demoPreTax * (1 + 6.625 / 100)).toFixed(2));
      console.log("[seed-if-empty] No orders — creating demo fulfilled order …");
      await prisma.order.create({
        data: {
          customerId: customer.id,
          recipeId: recipe?.id ?? null,
          status: OrderStatus.FULFILLED,
          quantityLbs: 25,
          paymentStatus: "PAID",
          subtotal: subtotalIncl,
          preTaxNet: demoPreTax,
          promoDiscountPreTax: 0,
          productSummary: "Beef & Organ Blend (Adult Dog) — demo line",
          pickedUpAt: new Date("2025-06-15T18:30:00.000Z"),
          paidAt: new Date("2025-06-15T19:00:00.000Z")
        }
      });
    }
  }

  const expCount = await prisma.expense.count();
  if (expCount === 0) {
    console.log("[seed-if-empty] No expenses — inserting sample expenses …");
    const samples = [
      {
        vendor: "Acme Packaging",
        category: "Supplies",
        amount: 42.5,
        expenseDate: new Date("2025-06-01"),
        notes: "Bags & labels"
      },
      {
        vendor: "Local Farm Co-op",
        category: "Ingredients",
        amount: 380,
        expenseDate: new Date("2025-06-08"),
        notes: "Weekly protein"
      },
      {
        vendor: "Utility",
        category: "Facilities",
        amount: 125,
        expenseDate: new Date("2025-06-10"),
        notes: "Electric"
      }
    ];
    for (const row of samples) {
      await prisma.expense.create({ data: row });
    }
  }

  const userCount = await prisma.user.count();
  if (userCount === 0) {
    console.log(`[seed-if-empty] No users — owner login ${DEMO_OWNER_EMAIL} / ${DEMO_OWNER_PASSWORD}`);
    const passwordHash = await bcrypt.hash(DEMO_OWNER_PASSWORD, 10);
    await prisma.user.create({
      data: {
        email: DEMO_OWNER_EMAIL,
        passwordHash,
        role: Role.OWNER
      }
    });
  }

  console.log("[seed-if-empty] Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
