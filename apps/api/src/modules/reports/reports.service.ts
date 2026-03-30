import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { isHubSheetOnly } from "../../hub-mode";
import { PrismaService } from "../prisma/prisma.service";
import { OperationsService } from "../operations/operations.service";
import { isPnlInventoryPurchaseExpenseCategory } from "../../domain/pnl-inventory-expense";

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly operations: OperationsService
  ) {}

  /** Splits sheet/API expenses into operating (runs through net profit) vs inventory-style purchases (excluded — already in COGS). */
  private splitExpensesForPnl(expenses: Array<{ amount?: unknown; category?: unknown }>): {
    operating: number;
    inventoryPurchases: number;
  } {
    let operating = 0;
    let inventoryPurchases = 0;
    for (const e of expenses) {
      const amt = Number(e.amount ?? 0);
      if (!Number.isFinite(amt)) continue;
      if (isPnlInventoryPurchaseExpenseCategory(e.category)) inventoryPurchases += amt;
      else operating += amt;
    }
    return { operating, inventoryPurchases };
  }

  private sheetReportsMode(): boolean {
    if (isHubSheetOnly()) return true;
    const url = String(this.config.get<string>("GOOGLE_SHEET_APPS_SCRIPT_URL") || "").trim();
    const site = String(this.config.get<string>("GOOGLE_SHEET_SITE_KEY") || "").trim();
    const key = String(this.config.get<string>("GOOGLE_SHEET_API_KEY") || "").trim();
    return Boolean(url && (site || key));
  }

  private inSheetDateRange(iso: string | undefined, from?: string, to?: string): boolean {
    if (!iso) return false;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return false;
    if (from) {
      const f = new Date(from);
      if (!Number.isNaN(f.getTime()) && d < f) return false;
    }
    if (to) {
      const t = new Date(to);
      if (!Number.isNaN(t.getTime()) && d > t) return false;
    }
    return true;
  }

  private buildDateFilter(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
    if (!from && !to) return undefined;
    return {
      gte: from ? new Date(from) : undefined,
      lte: to ? new Date(to) : undefined
    };
  }

  async pnlSummary() {
    if (this.sheetReportsMode()) {
      const [orders, expenses] = await Promise.all([this.operations.listOrders(), this.operations.listExpenses()]);
      const taxFactor = 1 + 0.06625;
      let revenue = 0;
      let netSales = 0;
      let cogs = 0;
      for (const o of orders as any[]) {
        if (String(o.status) === "CANCELLED") continue;
        const sub = Number(o.subtotal || 0);
        revenue += sub;
        netSales += sub > 0 ? sub / taxFactor : 0;
        cogs += Number(o.cogs || 0);
      }
      const split = this.splitExpensesForPnl(expenses as any[]);
      const expenseOperating = split.operating;
      const expenseInventoryPurchases = split.inventoryPurchases;
      const expenseTotalAll = expenseOperating + expenseInventoryPurchases;
      const grossProfit = netSales - cogs;
      const netProfit = netSales - cogs - expenseOperating;
      const byCategoryMap = new Map<string, number>();
      for (const e of expenses as any[]) {
        const c = String(e.category || "Other");
        byCategoryMap.set(c, (byCategoryMap.get(c) || 0) + Number(e.amount || 0));
      }
      const expensesByCategory = [...byCategoryMap.entries()]
        .map(([category, total]) => ({ category, total }))
        .sort((a, b) => b.total - a.total);
      return {
        revenue,
        cogs,
        grossProfit,
        // Operating expenses only (excludes inventory/ingredient purchase categories; see expensesInventoryPurchases).
        expenses: expenseOperating,
        expensesTotal: expenseTotalAll,
        expensesInventoryPurchases: expenseInventoryPurchases,
        netProfit,
        expensesByCategory
      };
    }
    const orders = await this.prisma.order.findMany({ select: { subtotal: true } });
    const expenses = await this.prisma.expense.findMany({ select: { amount: true, category: true } });
    const revenue = orders.reduce((sum: number, o: { subtotal: unknown }) => sum + Number(o.subtotal), 0);
    const split = this.splitExpensesForPnl(expenses);
    const expenseOperating = split.operating;
    const expenseInventoryPurchases = split.inventoryPurchases;
    const expenseTotalAll = expenseOperating + expenseInventoryPurchases;
    const cogs = 0;
    const grossProfit = revenue;
    const netProfit = revenue - expenseOperating;
    const byCategoryRaw = await this.prisma.expense.groupBy({
      by: ["category"],
      _sum: { amount: true }
    });
    const expensesByCategory = byCategoryRaw.map((item) => ({
      category: item.category,
      total: Number(item._sum.amount ?? 0)
    }));
    return {
      revenue,
      cogs,
      grossProfit,
      expenses: expenseOperating,
      expensesTotal: expenseTotalAll,
      expensesInventoryPurchases: expenseInventoryPurchases,
      netProfit,
      expensesByCategory
    };
  }

  async expenseCsv() {
    if (this.sheetReportsMode()) {
      const rows = (await this.operations.listExpenses()) as any[];
      const header = "vendor,category,amount,expenseDate,receiptPath,notes";
      const body = rows
        .map((r) => {
          const dt = r.expenseDate ? new Date(r.expenseDate) : new Date();
          const iso = Number.isNaN(dt.getTime()) ? String(r.expenseDate || "") : dt.toISOString();
          return [r.vendor, r.category, String(r.amount ?? 0), iso, r.receiptPath ?? "", r.notes ?? ""].join(",");
        })
        .join("\n");
      return `${header}\n${body}`;
    }
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
    if (this.sheetReportsMode()) {
      const rows = (await this.operations.listOrders()) as any[];
      const header = "orderId,customer,status,subtotal,cogs,margin,invoiceNumber,paymentStatus,createdAt";
      const body = rows
        .map((r) => {
          const cust = r.customer?.name ?? "";
          const inv = r.invoice?.invoiceNumber ?? "";
          const pay = r.invoice?.payment?.status ?? r.paymentStatus ?? "UNPAID";
          const ca = r.createdAt ? new Date(r.createdAt).toISOString() : "";
          return [
            r.id,
            cust,
            r.status,
            String(r.subtotal ?? 0),
            String(r.cogs ?? 0),
            String(r.margin ?? 0),
            inv,
            pay,
            ca
          ].join(",");
        })
        .join("\n");
      return `${header}\n${body}`;
    }
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
    if (this.sheetReportsMode()) {
      const all = (await this.operations.listExpenses()) as any[];
      const q = (params.query || "").trim().toLowerCase();
      const rows = all.filter((row) => {
        if (!this.inSheetDateRange(String(row.expenseDate || row.createdAt), params.from, params.to)) return false;
        if (params.category && String(row.category || "") !== params.category) return false;
        if (!q) return true;
        const blob = `${row.vendor || ""} ${row.category || ""} ${row.notes || ""}`.toLowerCase();
        return blob.includes(q);
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
    if (this.sheetReportsMode()) {
      const all = (await this.operations.listOrders()) as any[];
      const orders = all.filter((o) => this.inSheetDateRange(String(o.createdAt), params.from, params.to));
      const grossSales = orders.reduce((sum, o) => sum + Number(o.subtotal), 0);
      const paidSales = orders.reduce((sum, o) => {
        const st = String(o?.invoice?.payment?.status || o?.paymentStatus || "").toUpperCase();
        if (st === "PAID" || o?.paidAt) return sum + Number(o?.invoice?.payment?.amount ?? o?.subtotal ?? 0);
        return sum;
      }, 0);
      const unpaidSales = Math.max(0, grossSales - paidSales);
      return { orderCount: orders.length, grossSales, paidSales, unpaidSales };
    }
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
    if (this.sheetReportsMode()) {
      const taxFactor = 1 + 0.06625;
      const [allOrders, allExp] = await Promise.all([this.operations.listOrders(), this.operations.listExpenses()]);
      const orders = (allOrders as any[]).filter(
        (o) => String(o.status) !== "CANCELLED" && this.inSheetDateRange(String(o.createdAt), params.from, params.to)
      );
      const expenses = (allExp as any[]).filter((e) =>
        this.inSheetDateRange(String(e.expenseDate || e.createdAt), params.from, params.to)
      );
      const revenue = orders.reduce((sum, o) => sum + Number(o.subtotal), 0);
      const netSales = orders.reduce((sum, o) => {
        const sub = Number(o.subtotal || 0);
        return sum + (sub > 0 ? sub / taxFactor : 0);
      }, 0);
      const cogs = orders.reduce((sum, o) => sum + Number(o.cogs || 0), 0);
      const split = this.splitExpensesForPnl(expenses);
      const operatingExpenses = split.operating;
      const inventoryPurchaseExpenses = split.inventoryPurchases;
      const grossProfit = netSales - cogs;
      const netProfit = netSales - cogs - operatingExpenses;
      return {
        revenue,
        cogs,
        grossProfit,
        operatingExpenses,
        expensesTotal: operatingExpenses + inventoryPurchaseExpenses,
        expensesInventoryPurchases: inventoryPurchaseExpenses,
        netProfit
      };
    }
    const dateFilter = this.buildDateFilter(params.from, params.to);
    const [orders, expenses] = await Promise.all([
      this.prisma.order.findMany({ where: { createdAt: dateFilter }, select: { subtotal: true } }),
      this.prisma.expense.findMany({ where: { expenseDate: dateFilter }, select: { amount: true, category: true } })
    ]);
    const revenue = orders.reduce((sum, o) => sum + Number(o.subtotal), 0);
    const split = this.splitExpensesForPnl(expenses);
    const operatingExpenses = split.operating;
    const inventoryPurchaseExpenses = split.inventoryPurchases;
    const cogs = 0;
    const grossProfit = revenue;
    const netProfit = revenue - operatingExpenses;
    return {
      revenue,
      cogs,
      grossProfit,
      operatingExpenses,
      expensesTotal: operatingExpenses + inventoryPurchaseExpenses,
      expensesInventoryPurchases: inventoryPurchaseExpenses,
      netProfit
    };
  }

  async taxSummaryNJ(params: { from?: string; to?: string; salesTaxRate?: number }) {
    const taxRate = params.salesTaxRate ?? 0.06625;
    if (this.sheetReportsMode()) {
      const [allOrders, allExp] = await Promise.all([this.operations.listOrders(), this.operations.listExpenses()]);
      const orders = (allOrders as any[]).filter(
        (o) => String(o.status) !== "CANCELLED" && this.inSheetDateRange(String(o.createdAt), params.from, params.to)
      );
      const expenses = (allExp as any[]).filter((e) =>
        this.inSheetDateRange(String(e.expenseDate || e.createdAt), params.from, params.to)
      );
      const taxableSales = orders.reduce((sum, o) => sum + Number(o.subtotal), 0);
      const taxFactor = 1 + taxRate;
      const estimatedSalesTaxDue = orders.reduce((sum, o) => {
        const sub = Number(o.subtotal || 0);
        return sum + (sub > 0 ? sub - sub / taxFactor : 0);
      }, 0);
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
    const dateFilter = this.buildDateFilter(params.from, params.to);
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

  /** Static reference: NJ math, sheet formulas, P&amp;L notes. Safe to cache on the client. */
  calculatorReference() {
    const nj = 0.06625;
    return {
      version: 1 as const,
      njSalesTaxRate: nj,
      hubPnlNote:
        "Books operating expenses exclude inventory-style categories (Meats, Organs, Dairy, Fruits/Veggies, Fats, Supplements, Packaging) because order COGS already uses product cost/lb.",
      customerMetrics: {
        avgProfitPerCustomer:
          "For each customer: total lbs and total profit from their non-cancelled orders. Their blended profit/lb = profit ÷ lbs. Note: lbs × (profit ÷ lbs) = that customer’s profit. Summing those equals total profit. Average profit per customer = total profit ÷ (customers with lbs > 0).",
        avgCustomerBlendedProfitPerLb:
          "Simple average of each customer’s (profit ÷ lbs), only for customers with lbs > 0. This is not the same as total profit ÷ total lbs unless every customer has the same weight."
      },
      productMixTable: {
        profitPerLbColumn:
          "Per recipe row: sum(profit) ÷ sum(lbs) for that recipe — margin per pound of that SKU mix, not the customer-averaged rate above."
      },
      googleSheets_formulas: [
        {
          id: "pre_tax_from_tax_inclusive",
          description: "Pre-tax net when subtotal is NJ tax–included (shelf price).",
          formula: "=<subtotalTaxIncl>/(1+0.06625)",
          example: "=M2/(1+0.06625)"
        },
        {
          id: "embedded_sales_tax",
          description: "Tax dollars embedded in a tax-included subtotal.",
          formula: "=<subtotalTaxIncl>-<subtotalTaxIncl>/(1+0.06625)",
          example: "=M2-M2/(1+0.06625)"
        },
        {
          id: "product_cost_per_lb_vlookup",
          description:
            "Per product row: sum over ingredient columns of VLOOKUP(ingredient name, Ingredients!$B:$F, 4, FALSE) × (ratio%/100). Matches jr-sheet-controller applyFormulaForProductRow_.",
          formula:
            "=ROUND(IFERROR(VLOOKUP(B2,Ingredients!$B:$F,4,FALSE),0)*IFERROR(C2,0)/100+IFERROR(VLOOKUP(D2,Ingredients!$B:$F,4,FALSE),0)*IFERROR(E2,0)/100,4)",
          notes: "Replace B2/C2/D2/E2 with your ingredient name + ratio columns; extend with + terms for more ingredients."
        }
      ],
      archiveImport: {
        recommendation:
          "Do not paste legacy “Profit” / “Profit per lb” from old workbooks into Archive unless they match hub COGS. Prefer blanks and sync, or use --legacy-profit-columns on the Jersey Raw import script only for reconciliation.",
        preTaxNet: "Should equal subtotalTaxIncl/(1+0.06625) for NJ when no coupon adjusts the subtotal."
      },
      endpoints: {
        calculatorJson: "GET /reports/calculator",
        calculatorTemplateCsv: "GET /reports/calculator/sheet-template.csv"
      }
    };
  }

  /** One-shot CSV you can open in Google Sheets: topic + sample formulas (adjust column letters to your sheet). */
  calculatorSheetTemplateCsv(): string {
    const rows: string[][] = [
      ["topic", "field", "sample_formula", "notes"],
      ["nj_tax", "preTaxNet", "=M2/(1+0.06625)", "M2 = subtotalTaxIncl on row 2"],
      ["nj_tax", "embedded_tax", "=M2-M2/(1+0.06625)", "Tax portion inside subtotal"],
      ["archive", "profit", "", "Leave blank for hub/Apps Script; or = preTaxNet - COGS if you maintain COGS column"],
      ["archive", "profitPerLb", "", "Leave blank; or =IF(Q2>0,R2/Q2,0) if profit col R and lbs col Q"],
      ["pnl", "operating_expense_sum", "=SUMIF(C:C,\"<>Meats\",B:B)", "Example only — exclude each inventory category or use hub P&L"],
      ["products", "costPerLb", "=ROUND(SUMPRODUCT(...),4)", "Use per-ingredient VLOOKUP × ratio/100; see calculator JSON for full pattern"]
    ];
    return rows.map((r) => r.map((c) => (c.includes(",") || c.includes('"') ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";
  }
}
