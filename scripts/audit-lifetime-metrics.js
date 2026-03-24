const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const orders = await prisma.order.findMany();
  const expenses = await prisma.expense.findMany();

  const lifeWeight = orders.reduce((s, o) => s + Number(o.quantityLbs || 0), 0);
  const lifeSales = orders.reduce((s, o) => s + Number(o.subtotal || 0), 0);
  const lifeProfit = orders.reduce((s, o) => s + Number(o.margin || 0), 0);
  const avgProfitPerLb = lifeWeight > 0 ? lifeProfit / lifeWeight : 0;
  const lifeSpent = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const expensesProfit = lifeSales - lifeSpent;
  const salesTax = lifeSales * 0.06625;
  const packagingCleaning = expenses
    .filter((e) => {
      const c = String(e.category || "").toLowerCase();
      return c.includes("packag") || c.includes("utilit") || c.includes("clean");
    })
    .reduce((s, e) => s + Number(e.amount || 0), 0);
  const meatProfit = lifeProfit - packagingCleaning;

  console.log(
    JSON.stringify(
      {
        orders: orders.length,
        expenses: expenses.length,
        lifeWeight,
        lifeSpent,
        lifeSales,
        lifeProfit,
        avgProfitPerLb,
        salesTax,
        expensesProfit,
        packagingCleaning,
        meatProfit
      },
      null,
      2
    )
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
