import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private buildDateFilter(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
    if (!from && !to) return undefined;
    return {
      gte: from ? new Date(from) : undefined,
      lte: to ? new Date(to) : undefined
    };
  }

  async pnlSummary() {
    const orders = await this.prisma.order.findMany({ select: { subtotal: true } });
    const expenses = await this.prisma.expense.findMany({ select: { amount: true } });
    const revenue = orders.reduce((sum: number, o: { subtotal: unknown }) => sum + Number(o.subtotal), 0);
    const expenseTotal = expenses.reduce((sum: number, e: { amount: unknown }) => sum + Number(e.amount), 0);
    const cogs = 0;
    const grossProfit = revenue;
    const netProfit = revenue - expenseTotal;
    const byCategoryRaw = await this.prisma.expense.groupBy({
      by: ["category"],
      _sum: { amount: true }
    });
    const expensesByCategory = byCategoryRaw.map((item) => ({
      category: item.category,
      total: Number(item._sum.amount ?? 0)
    }));
    return { revenue, cogs, grossProfit, expenses: expenseTotal, netProfit, expensesByCategory };
  }

  async expenseCsv() {
    const rows = await this.prisma.expense.findMany({ orderBy: { expenseDate: "desc" } });
    const header = "vendor,category,amount,expenseDate,receiptPath,notes";
    const body = rows
      .map((r: { vendor: string; category: string; amount: { toString(): string }; expenseDate: Date; receiptPath: string | null; notes: string | null }) =>
        [r.vendor, r.category, r.amount.toString(), r.expenseDate.toISOString(), r.receiptPath ?? "", r.notes ?? ""].join(",")
      )
      .join("\n");
    return `${header}\n${body}`;
  }

  async orderCsv() {
    const rows = await this.prisma.order.findMany({
      include: { customer: true, invoice: { include: { payment: true } } },
      orderBy: { createdAt: "desc" }
    });
    const header = "orderId,customer,status,subtotal,cogs,margin,invoiceNumber,paymentStatus,createdAt";
    const body = rows
      .map((r) =>
        [
          r.id,
          r.customer.name,
          r.status,
          r.subtotal.toString(),
          (r.cogs ?? 0).toString(),
          (r.margin ?? 0).toString(),
          r.invoice?.invoiceNumber ?? "",
          r.invoice?.payment?.status ?? "UNPAID",
          r.createdAt.toISOString()
        ].join(",")
      )
      .join("\n");
    return `${header}\n${body}`;
  }

  async expenseBreakdown(params: { from?: string; to?: string; category?: string; query?: string }) {
    const dateFilter = this.buildDateFilter(params.from, params.to);
    const rows = await this.prisma.expense.findMany({
      where: {
        expenseDate: dateFilter,
        category: params.category ? params.category : undefined,
        OR: params.query
          ? [{ vendor: { contains: params.query } }, { category: { contains: params.query } }, { notes: { contains: params.query } }]
          : undefined
      },
      orderBy: { expenseDate: "desc" }
    });
    const grouped = rows.reduce((acc: Record<string, number>, row) => {
      acc[row.category] = (acc[row.category] ?? 0) + Number(row.amount);
      return acc;
    }, {});
    const byCategory = Object.entries(grouped)
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);
    const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
    return { total, count: rows.length, byCategory, rows };
  }

  async salesSummary(params: { from?: string; to?: string }) {
    const dateFilter = this.buildDateFilter(params.from, params.to);
    const orders = await this.prisma.order.findMany({
      where: { createdAt: dateFilter },
      include: { invoice: { include: { payment: true } } },
      orderBy: { createdAt: "desc" }
    });
    const grossSales = orders.reduce((sum, o) => sum + Number(o.subtotal), 0);
    const paidSales = orders.reduce((sum, o) => sum + Number(o.invoice?.payment?.amount ?? 0), 0);
    const unpaidSales = Math.max(0, grossSales - paidSales);
    return { orderCount: orders.length, grossSales, paidSales, unpaidSales };
  }

  async profitSummary(params: { from?: string; to?: string }) {
    const dateFilter = this.buildDateFilter(params.from, params.to);
    const [orders, expenses] = await Promise.all([
      this.prisma.order.findMany({ where: { createdAt: dateFilter }, select: { subtotal: true } }),
      this.prisma.expense.findMany({ where: { expenseDate: dateFilter }, select: { amount: true } })
    ]);
    const revenue = orders.reduce((sum, o) => sum + Number(o.subtotal), 0);
    const operatingExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const cogs = 0;
    const grossProfit = revenue;
    const netProfit = revenue - operatingExpenses;
    return { revenue, cogs, grossProfit, operatingExpenses, netProfit };
  }

  async taxSummaryNJ(params: { from?: string; to?: string; salesTaxRate?: number }) {
    const dateFilter = this.buildDateFilter(params.from, params.to);
    const taxRate = params.salesTaxRate ?? 0.06625;
    const [orders, expenses] = await Promise.all([
      this.prisma.order.findMany({ where: { createdAt: dateFilter }, select: { subtotal: true } }),
      this.prisma.expense.findMany({ where: { expenseDate: dateFilter }, select: { amount: true, category: true } })
    ]);
    const taxableSales = orders.reduce((sum, o) => sum + Number(o.subtotal), 0);
    const estimatedSalesTaxDue = taxableSales * taxRate;
    const deductibleExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const expenseCategories = expenses.reduce((acc: Record<string, number>, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + Number(e.amount);
      return acc;
    }, {});
    const deductibleByCategory = Object.entries(expenseCategories)
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);
    return {
      njSalesTaxRate: taxRate,
      taxableSales,
      estimatedSalesTaxDue,
      deductibleExpenses,
      deductibleByCategory
    };
  }
}
