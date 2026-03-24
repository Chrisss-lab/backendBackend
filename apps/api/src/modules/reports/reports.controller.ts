import { Controller, Get, Header, Query } from "@nestjs/common";
import { ReportsService } from "./reports.service";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("pnl")
  pnl() {
    return this.reports.pnlSummary();
  }

  @Get("expenses.csv")
  @Header("Content-Type", "text/csv")
  async expensesCsv() {
    return this.reports.expenseCsv();
  }

  @Get("orders.csv")
  @Header("Content-Type", "text/csv")
  async ordersCsv() {
    return this.reports.orderCsv();
  }

  @Get("expenses/breakdown")
  expenseBreakdown(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("category") category?: string,
    @Query("query") query?: string
  ) {
    return this.reports.expenseBreakdown({ from, to, category, query });
  }

  @Get("sales/summary")
  salesSummary(@Query("from") from?: string, @Query("to") to?: string) {
    return this.reports.salesSummary({ from, to });
  }

  @Get("profit/summary")
  profitSummary(@Query("from") from?: string, @Query("to") to?: string) {
    return this.reports.profitSummary({ from, to });
  }

  @Get("tax/nj")
  taxNjSummary(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("salesTaxRate") salesTaxRate?: string
  ) {
    return this.reports.taxSummaryNJ({
      from,
      to,
      salesTaxRate: salesTaxRate ? Number(salesTaxRate) : undefined
    });
  }
}
