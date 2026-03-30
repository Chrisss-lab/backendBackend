/**
 * Pure dashboard aggregates (ported from web `page.tsx`) for server-side compute.
 * Dates in outputs use ISO strings for JSON; callers may hydrate to Date on the client.
 */

import { isPnlInventoryPurchaseExpenseCategory } from "../../domain/pnl-inventory-expense";

const NJ_TAX_INCLUDED_DIVISOR = 1 + 0.06625;

export type LifetimePriorAdjust = {
  salesTaxIncl: number;
  totalLbs: number;
  expenses: number;
  cogs: number;
  netSales: number;
  taxCollected: number;
};

export const DEFAULT_LIFETIME_PRIOR: LifetimePriorAdjust = {
  salesTaxIncl: 0,
  totalLbs: 0,
  expenses: 0,
  cogs: 0,
  netSales: 0,
  taxCollected: 0
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function parseOrderItemLines(
  o: any,
  recipes: any[]
): Array<{ recipeName: string; recipeId: string; quantityLbs: number }> {
  const taxDiv = NJ_TAX_INCLUDED_DIVISOR;
  const subtotalOrd = Number(o?.subtotal ?? 0);

  const resolveProd = (rid: string, recipeName: string) => {
    let prod = rid ? recipes.find((r: any) => r.id === rid) : undefined;
    if (!prod && recipeName) {
      const k = recipeName.toLowerCase();
      prod = recipes.find((r: any) => String(r.name || "").trim().toLowerCase() === k);
    }
    return prod;
  };

  try {
    const parsed = JSON.parse(String(o?.orderItemsJson || "[]"));
    if (Array.isArray(parsed) && parsed.length > 0) {
      type Raw = {
        recipeName: string;
        recipeId: string;
        qRaw: number;
        qLbsField: number;
        qUnit: string;
        unitPrice: number;
        prod: any;
      };
      const raws: Raw[] = [];
      for (const x of parsed) {
        const recipeName = String(x?.recipeName || x?.productName || "").trim();
        const rid = String(x?.productId || x?.recipeId || "").trim();
        const prod = resolveProd(rid, recipeName);
        const nameOut = recipeName || String(prod?.name || "").trim();
        if (!nameOut) continue;
        const idOut = rid || String(prod?.id || "").trim();
        const qRaw = Number(x?.quantity ?? 0);
        const qLbsField = Number(x?.quantityLbs ?? 0);
        const qUnit = String(x?.quantityUnit || "lb").toLowerCase();
        const unitPrice = Number(x?.unitPrice ?? x?.salePrice ?? x?.price ?? prod?.salePrice ?? 0);
        raws.push({ recipeName: nameOut, recipeId: idOut, qRaw, qLbsField, qUnit, unitPrice, prod });
      }

      const canonicalLbsQty = (r: Raw) =>
        r.qLbsField > 0 && r.qUnit === "lb" && (r.qRaw <= 0 || Math.abs(r.qRaw - r.qLbsField) < 1e-6);

      const lbsAsPoundsQtyField = (r: Raw) => {
        const q = r.qRaw > 0 ? r.qRaw : r.qLbsField;
        const apu = Math.max(0.0001, Number(r.prod?.amountPerUnit ?? 1));
        return r.qUnit === "lb" ? q : q * apu;
      };

      const lbsLForRow = (r: Raw) => {
        if (canonicalLbsQty(r)) return r.qLbsField;
        return lbsAsPoundsQtyField(r);
      };

      const lbsMForRow = (r: Raw) => {
        if (r.unitPrice > 0 && r.qUnit === "lb" && r.qRaw > 0) {
          return r.qRaw / taxDiv / r.unitPrice;
        }
        if (canonicalLbsQty(r)) return r.qLbsField;
        return lbsAsPoundsQtyField(r);
      };

      const inclLForRow = (r: Raw) => {
        if (!(r.unitPrice > 0)) return 0;
        const lbs = lbsLForRow(r);
        return lbs * r.unitPrice * taxDiv;
      };

      const staged = raws
        .map((r) => ({
          r,
          lbsL: lbsLForRow(r),
          lbsM: lbsMForRow(r)
        }))
        .filter((x) => x.r.recipeName && x.lbsL > 0);

      if (!staged.length) return [];

      const sumInclL = staged.reduce((s, x) => s + inclLForRow(x.r), 0);
      const sumInclM = staged.reduce((s, x) => {
        if (!(x.r.unitPrice > 0) || !(x.r.qRaw > 0)) return s;
        return s + x.r.qRaw;
      }, 0);
      const sumLbsL = staged.reduce((s, x) => s + x.lbsL, 0);
      const sumLbsM = staged.reduce((s, x) => s + Math.max(0, x.lbsM), 0);
      const maxLbsL = Math.max(...staged.map((x) => x.lbsL));

      let useMoney = false;
      if (subtotalOrd > 0.01) {
        const errL = Math.abs(sumInclL - subtotalOrd);
        const errM = Math.abs(sumInclM - subtotalOrd);
        if (sumInclM > 0.01) {
          useMoney = errM + 0.005 * subtotalOrd < errL;
        }
      } else if (staged.some((x) => x.r.unitPrice > 0)) {
        useMoney = maxLbsL > 60 && sumLbsM > 0.25 && sumLbsM < sumLbsL * 0.4;
      }

      return staged.map((x) => ({
        recipeName: x.r.recipeName,
        recipeId: x.r.recipeId,
        quantityLbs: useMoney ? Math.max(0, x.lbsM) : x.lbsL
      }));
    }
  } catch {
    /* fallback */
  }
  const fallback = String(o?.recipe?.name || recipes.find((r: any) => r.id === o?.recipeId)?.name || "").trim();
  const lbs = Number(o?.quantityLbs || 0);
  const fid = String(o?.recipeId || "").trim();
  if (fallback && lbs > 0) return [{ recipeName: fallback, recipeId: fid, quantityLbs: lbs }];
  return [];
}

export function orderMetrics(
  o: any,
  recipes: any[]
): {
  lbs: number;
  subtotal: number;
  salesTax: number;
  netRevenue: number;
  cogs: number;
  profitTotal: number;
  pricePerLb: number;
  profitPerLb: number;
} {
  const lines = parseOrderItemLines(o, recipes);
  let lbs = Number(o?.quantityLbs || 0);
  if (!(lbs > 0)) {
    lbs = lines.reduce((s, l) => s + Number(l.quantityLbs || 0), 0);
  }
  const subtotal = Number(o?.subtotalTaxIncl ?? o?.subtotal ?? 0);
  const preTaxNet = Number(o?.preTaxNet || 0);
  const salesTax = subtotal > 0 ? subtotal - (preTaxNet > 0 ? preTaxNet : subtotal / NJ_TAX_INCLUDED_DIVISOR) : 0;
  const netRevenue = preTaxNet > 0 ? preTaxNet : subtotal - salesTax;

  const hasStoredProfit = o?.profit !== undefined && o?.profit !== null && String(o?.profit) !== "";
  const hasStoredProfitPerLb = o?.profitPerLb !== undefined && o?.profitPerLb !== null && String(o?.profitPerLb) !== "";
  const storedProfit = Number(hasStoredProfit ? o?.profit : o?.margin ?? 0);
  const storedProfitPerLb = Number(hasStoredProfitPerLb ? o?.profitPerLb : 0);
  let cogs = Number(o?.cogs || 0);
  if (!(cogs > 0) && (hasStoredProfit || storedProfit !== 0) && netRevenue > 0) {
    cogs = netRevenue - storedProfit;
  }
  if (!(cogs > 0) && lines.length) {
    let est = 0;
    for (const ln of lines) {
      const rec = ln.recipeId
        ? recipes.find((r: any) => r.id === ln.recipeId)
        : recipes.find((r: any) => String(r.name || "").trim().toLowerCase() === ln.recipeName.toLowerCase());
      if (rec) est += ln.quantityLbs * Number(rec.costPerPound || 0);
    }
    if (est > 0) cogs = est;
  }
  const profitTotal = hasStoredProfit ? storedProfit : cogs > 0 ? netRevenue - cogs : 0;
  const pricePerLb = lbs > 0 ? netRevenue / lbs : 0;
  let profitPerLb = 0;
  if (lbs > 0) {
    if (hasStoredProfit) profitPerLb = profitTotal / lbs;
    else if (hasStoredProfitPerLb) profitPerLb = storedProfitPerLb;
    else profitPerLb = profitTotal / lbs;
  }
  return { lbs, subtotal, salesTax, netRevenue, cogs, profitTotal, pricePerLb, profitPerLb };
}

export type WeeklyBucketJson = {
  startIso: string;
  endIso: string;
  label: string;
  salesTaxIncl: number;
  netSales: number;
  taxCollected: number;
  cogs: number;
  profit: number;
  expenses: number;
  orders: number;
  lbs: number;
  cancelled: number;
};

export function computeDashboardAnalytics(input: {
  orders: any[];
  expenses: any[];
  recipes: any[];
  invoices: any[];
  inventory: any[];
  customers: any[];
  ingredients: any[];
  reportFrom: string;
  reportTo: string;
  weeksBack: 8 | 12 | 26;
  lifetimePrior?: LifetimePriorAdjust;
}): {
  reportSummary: Record<string, unknown>;
  dashboardWeekly: {
    buckets: WeeklyBucketJson[];
    totals: Record<string, number>;
    maxSales: number;
    maxProfit: number;
    maxExpenses: number;
    weeksBack: number;
    lineScaleMax: number;
  };
  dashboardPeriodBounds: { rangeStartIso: string; rangeEndIso: string };
  dashboardPeriodLbsByRecipe: Array<{ recipe: string; lbs: number }>;
  dashboardLeaderboards: Record<string, unknown>;
  dashboardLifetimeStats: Record<string, unknown>;
} {
  const {
    orders,
    expenses,
    recipes,
    invoices,
    inventory,
    customers,
    ingredients,
    reportFrom,
    reportTo,
    weeksBack
  } = input;
  const prior = input.lifetimePrior ?? DEFAULT_LIFETIME_PRIOR;

  const fromDate = reportFrom ? startOfDay(new Date(reportFrom)) : null;
  const toDate = reportTo ? endOfDay(new Date(reportTo)) : null;
  const inRange = (value: unknown) => {
    const d = new Date(String(value || ""));
    if (Number.isNaN(d.getTime())) return false;
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  };

  const ordersInRange = orders.filter((o: any) => inRange(o.createdAt));
  const activeOrdersInRange = ordersInRange.filter((o: any) => o.status !== "CANCELLED");
  const cancelledOrdersInRange = ordersInRange.filter((o: any) => o.status === "CANCELLED");
  const expensesInRange = expenses.filter((e: any) => inRange(e.expenseDate || e.createdAt));

  const orderTotals = activeOrdersInRange.reduce(
    (acc: any, o: any) => {
      const m = orderMetrics(o, recipes);
      acc.orders += 1;
      acc.lbs += m.lbs;
      acc.salesTaxIncl += m.subtotal;
      acc.netSales += m.netRevenue;
      acc.taxCollected += m.salesTax;
      acc.cogs += m.cogs;
      acc.profit += m.profitTotal;
      return acc;
    },
    { orders: 0, lbs: 0, salesTaxIncl: 0, netSales: 0, taxCollected: 0, cogs: 0, profit: 0 }
  );

  const expenseTotal = expensesInRange.reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
  const expenseOperatingForPnl = expensesInRange.reduce(
    (sum: number, e: any) => sum + (isPnlInventoryPurchaseExpenseCategory(e.category) ? 0 : Number(e.amount || 0)),
    0
  );
  const expenseByCategoryMap = new Map<string, number>();
  for (const e of expensesInRange) {
    const key = String(e.category || "Other");
    expenseByCategoryMap.set(key, (expenseByCategoryMap.get(key) || 0) + Number(e.amount || 0));
  }
  const expenseByCategory = [...expenseByCategoryMap.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);

  const itemMap = new Map<string, { item: string; orders: number; lbs: number; salesTaxIncl: number; netSales: number; profit: number }>();
  for (const o of activeOrdersInRange) {
    const itemName = String(o.recipe?.name || recipes.find((r: any) => r.id === o.recipeId)?.name || "Unknown item");
    const m = orderMetrics(o, recipes);
    const curr = itemMap.get(itemName) || { item: itemName, orders: 0, lbs: 0, salesTaxIncl: 0, netSales: 0, profit: 0 };
    curr.orders += 1;
    curr.lbs += m.lbs;
    curr.salesTaxIncl += m.subtotal;
    curr.netSales += m.netRevenue;
    curr.profit += m.profitTotal;
    itemMap.set(itemName, curr);
  }
  const items = [...itemMap.values()].sort((a, b) => b.salesTaxIncl - a.salesTaxIncl);

  const customerMap = new Map<string, number>();
  for (const o of activeOrdersInRange) {
    const name = String(o.customer?.name || "Unknown customer");
    const m = orderMetrics(o, recipes);
    customerMap.set(name, (customerMap.get(name) || 0) + m.subtotal);
  }
  const topCustomer = [...customerMap.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  const avgOrderValue = orderTotals.orders > 0 ? orderTotals.salesTaxIncl / orderTotals.orders : 0;
  const profitPerLbReport = orderTotals.lbs > 0 ? orderTotals.profit / orderTotals.lbs : 0;
  const netAfterExpensesReport = orderTotals.netSales - expenseTotal;
  const marginPct = orderTotals.netSales > 0 ? (orderTotals.profit / orderTotals.netSales) * 100 : 0;
  const expenseRatioPct = orderTotals.netSales > 0 ? (expenseOperatingForPnl / orderTotals.netSales) * 100 : 0;

  const reportSummary = {
    fromDateIso: fromDate ? fromDate.toISOString() : null,
    toDateIso: toDate ? toDate.toISOString() : null,
    ordersInRangeCount: ordersInRange.length,
    cancelledOrderCount: cancelledOrdersInRange.length,
    expenseCount: expensesInRange.length,
    orderTotals,
    expenseTotal,
    expenseOperatingForPnl,
    expenseByCategory,
    items,
    avgOrderValue,
    profitPerLb: profitPerLbReport,
    netAfterExpenses: netAfterExpensesReport,
    marginPct,
    expenseRatioPct,
    topCustomer
  };

  const now = new Date();
  const thisWeekStart = startOfDay(new Date(now));
  thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
  const weekStarts = Array.from({ length: weeksBack }, (_, idx) => {
    const d = new Date(thisWeekStart);
    d.setDate(d.getDate() - (weeksBack - 1 - idx) * 7);
    return d;
  });
  const bucketsMutable = weekStarts.map((start) => {
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return {
      start,
      end,
      label: `${String(start.getMonth() + 1).padStart(2, "0")}/${String(start.getDate()).padStart(2, "0")}`,
      salesTaxIncl: 0,
      netSales: 0,
      taxCollected: 0,
      cogs: 0,
      profit: 0,
      expenses: 0,
      orders: 0,
      lbs: 0,
      cancelled: 0
    };
  });
  const getWeekIndex = (d: Date) => bucketsMutable.findIndex((b) => d >= b.start && d <= b.end);

  for (const o of orders) {
    const d = new Date(String(o.createdAt || ""));
    if (Number.isNaN(d.getTime())) continue;
    const idx = getWeekIndex(d);
    if (idx < 0) continue;
    if (String(o.status || "").toUpperCase() === "CANCELLED") {
      bucketsMutable[idx].cancelled += 1;
      continue;
    }
    const m = orderMetrics(o, recipes);
    bucketsMutable[idx].orders += 1;
    bucketsMutable[idx].lbs += m.lbs;
    bucketsMutable[idx].salesTaxIncl += m.subtotal;
    bucketsMutable[idx].netSales += m.netRevenue;
    bucketsMutable[idx].taxCollected += m.salesTax;
    bucketsMutable[idx].cogs += m.cogs;
  }
  for (const e of expenses) {
    const d = new Date(String(e.expenseDate || e.createdAt || ""));
    if (Number.isNaN(d.getTime())) continue;
    const idx = getWeekIndex(d);
    if (idx < 0) continue;
    if (isPnlInventoryPurchaseExpenseCategory(e.category)) continue;
    bucketsMutable[idx].expenses += Number(e.amount || 0);
  }
  for (const w of bucketsMutable) {
    w.profit = w.netSales - w.cogs - w.expenses;
  }

  const totals = bucketsMutable.reduce(
    (acc, w) => {
      acc.salesTaxIncl += w.salesTaxIncl;
      acc.netSales += w.netSales;
      acc.taxCollected += w.taxCollected;
      acc.cogs += w.cogs;
      acc.profit += w.profit;
      acc.expenses += w.expenses;
      acc.orders += w.orders;
      acc.lbs += w.lbs;
      acc.cancelled += w.cancelled;
      return acc;
    },
    { salesTaxIncl: 0, netSales: 0, taxCollected: 0, cogs: 0, profit: 0, expenses: 0, orders: 0, lbs: 0, cancelled: 0 }
  );
  const maxSales = Math.max(1, ...bucketsMutable.map((w) => w.salesTaxIncl));
  const maxProfit = Math.max(1, ...bucketsMutable.map((w) => w.profit));
  const maxExpenses = Math.max(1, ...bucketsMutable.map((w) => w.expenses));
  const allMoney = bucketsMutable.flatMap((w) => [w.salesTaxIncl, w.profit, w.expenses]);
  const lineScaleMax = Math.max(1, ...allMoney.map((v) => Math.abs(v)));

  const buckets: WeeklyBucketJson[] = bucketsMutable.map((w) => ({
    startIso: w.start.toISOString(),
    endIso: w.end.toISOString(),
    label: w.label,
    salesTaxIncl: w.salesTaxIncl,
    netSales: w.netSales,
    taxCollected: w.taxCollected,
    cogs: w.cogs,
    profit: w.profit,
    expenses: w.expenses,
    orders: w.orders,
    lbs: w.lbs,
    cancelled: w.cancelled
  }));

  const dashboardWeekly = {
    buckets,
    totals,
    maxSales,
    maxProfit,
    maxExpenses,
    weeksBack,
    lineScaleMax
  };

  const rangeStart = startOfDay(new Date(thisWeekStart));
  rangeStart.setDate(rangeStart.getDate() - (weeksBack - 1) * 7);
  const rangeEnd = endOfDay(new Date(thisWeekStart));
  rangeEnd.setDate(rangeEnd.getDate() + 6);
  const dashboardPeriodBounds = { rangeStartIso: rangeStart.toISOString(), rangeEndIso: rangeEnd.toISOString() };

  const best = <T,>(rows: T[], score: (row: T) => number) => [...rows].sort((a, b) => score(b) - score(a))[0] ?? null;

  const weekly = bucketsMutable.map((w) => ({
    label: w.label,
    startIso: w.start.toISOString(),
    endIso: w.end.toISOString(),
    grossProfit: w.netSales - w.cogs,
    netAfterExpenses: w.netSales - w.cogs - w.expenses,
    sales: w.salesTaxIncl,
    lbs: w.lbs,
    orders: w.orders
  }));

  const monthMap = new Map<
    string,
    {
      key: string;
      label: string;
      grossProfit: number;
      expenses: number;
      netAfterExpenses: number;
      sales: number;
      netSales: number;
      cogs: number;
      lbs: number;
      orders: number;
    }
  >();
  const monthName = (d: Date) =>
    d.toLocaleDateString(undefined, {
      month: "short",
      year: "numeric"
    });

  for (const o of orders) {
    const d = new Date(String(o.createdAt || ""));
    if (Number.isNaN(d.getTime())) continue;
    if (String(o.status || "").toUpperCase() === "CANCELLED") continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const cur =
      monthMap.get(key) ??
      ({
        key,
        label: monthName(d),
        grossProfit: 0,
        expenses: 0,
        netAfterExpenses: 0,
        sales: 0,
        netSales: 0,
        cogs: 0,
        lbs: 0,
        orders: 0
      } as const);
    const m = orderMetrics(o, recipes);
    monthMap.set(key, {
      ...cur,
      grossProfit: cur.grossProfit + m.profitTotal,
      sales: cur.sales + m.subtotal,
      netSales: cur.netSales + m.netRevenue,
      cogs: cur.cogs + m.cogs,
      lbs: cur.lbs + m.lbs,
      orders: cur.orders + 1
    });
  }
  for (const e of expenses) {
    const d = new Date(String(e.expenseDate || e.createdAt || ""));
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const cur =
      monthMap.get(key) ??
      ({
        key,
        label: monthName(d),
        grossProfit: 0,
        expenses: 0,
        netAfterExpenses: 0,
        sales: 0,
        netSales: 0,
        cogs: 0,
        lbs: 0,
        orders: 0
      } as const);
    if (isPnlInventoryPurchaseExpenseCategory(e.category)) continue;
    monthMap.set(key, {
      ...cur,
      expenses: cur.expenses + Number(e.amount || 0)
    });
  }
  const monthly = [...monthMap.values()]
    .map((m) => ({ ...m, netAfterExpenses: m.netSales - m.cogs - m.expenses }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const dashboardLeaderboards = {
    bestWeekNet: best(weekly, (x) => x.netAfterExpenses),
    bestWeekGross: best(weekly, (x) => x.grossProfit),
    bestWeekLbs: best(weekly, (x) => x.lbs),
    bestWeekSales: best(weekly, (x) => x.sales),
    bestMonthNet: best(monthly, (x) => x.netAfterExpenses),
    bestMonthGross: best(monthly, (x) => x.grossProfit),
    bestMonthLbs: best(monthly, (x) => x.lbs),
    bestMonthSales: best(monthly, (x) => x.sales)
  };

  const p0 = rangeStart;
  const p1b = rangeEnd;
  const ordersInPeriod = orders.filter((o: any) => {
    const d = new Date(o.createdAt);
    return d >= p0 && d <= p1b;
  });
  const mLbsRecipe = new Map<string, number>();
  for (const o of ordersInPeriod) {
    if (String(o.status || "").toUpperCase() === "CANCELLED") continue;
    const om = orderMetrics(o, recipes);
    const name = String(o.recipe?.name || recipes.find((r: any) => r.id === o.recipeId)?.name || "â€”");
    mLbsRecipe.set(name, (mLbsRecipe.get(name) || 0) + om.lbs);
  }
  const dashboardPeriodLbsByRecipe = [...mLbsRecipe.entries()]
    .map(([recipe, lbs]) => ({ recipe, lbs }))
    .sort((a, b) => b.lbs - a.lbs);

  let activeOrders = 0;
  let cancelledOrders = 0;
  let pendingPipeline = 0;
  let fulfilled = 0;
  let paidOrders = 0;
  let totalLbs = 0;
  let salesTaxIncl = 0;
  let netSales = 0;
  let taxCollected = 0;
  let totalCogs = 0;
  let totalProfit = 0;
  let invoicesOnOrders = 0;
  let invoicedAmount = 0;
  const customerIds = new Set<string>();
  const expenseByCategoryMapLt = new Map<string, number>();
  const itemMapLt = new Map<string, { item: string; orders: number; lbs: number; salesTaxIncl: number; netSales: number; profit: number }>();

  for (const o of orders) {
    if (o.customerId) customerIds.add(o.customerId);
    if (o.status === "CANCELLED") {
      cancelledOrders += 1;
      continue;
    }
    activeOrders += 1;
    if (o.status === "NEW" || o.status === "CONFIRMED") pendingPipeline += 1;
    if (o.status === "FULFILLED") fulfilled += 1;
    const paid = Boolean(o?.paidAt) || String(o?.paymentStatus || "").toUpperCase() === "PAID";
    if (paid) paidOrders += 1;
    const m = orderMetrics(o, recipes);
    totalLbs += m.lbs;
    salesTaxIncl += m.subtotal;
    netSales += m.netRevenue;
    taxCollected += m.salesTax;
    totalCogs += m.cogs;
    totalProfit += m.profitTotal;
    if (o.invoice) {
      invoicesOnOrders += 1;
      invoicedAmount += Number(o.invoice?.amount || 0);
    }
    const itemName = String(o.recipe?.name || recipes.find((r: any) => r.id === o.recipeId)?.name || "Unknown item");
    const curr = itemMapLt.get(itemName) || { item: itemName, orders: 0, lbs: 0, salesTaxIncl: 0, netSales: 0, profit: 0 };
    curr.orders += 1;
    curr.lbs += m.lbs;
    curr.salesTaxIncl += m.subtotal;
    curr.netSales += m.netRevenue;
    curr.profit += m.profitTotal;
    itemMapLt.set(itemName, curr);
  }

  let expenseOperatingForPnlLt = 0;
  for (const e of expenses) {
    const key = String(e.category || "Other");
    const amt = Number(e.amount || 0);
    expenseByCategoryMapLt.set(key, (expenseByCategoryMapLt.get(key) || 0) + amt);
    if (!isPnlInventoryPurchaseExpenseCategory(e.category)) expenseOperatingForPnlLt += amt;
  }
  let expenseTotalLt = [...expenseByCategoryMapLt.values()].reduce((a, b) => a + b, 0);
  const expenseByCategoryLt = [...expenseByCategoryMapLt.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
  const topItems = [...itemMapLt.values()].sort((a, b) => b.salesTaxIncl - a.salesTaxIncl).slice(0, 12);

  salesTaxIncl += prior.salesTaxIncl;
  netSales += prior.netSales;
  taxCollected += prior.taxCollected;
  totalLbs += prior.totalLbs;
  expenseTotalLt += prior.expenses;
  expenseOperatingForPnlLt += prior.expenses;

  const avgOrderTaxIncl = activeOrders > 0 ? salesTaxIncl / activeOrders : 0;
  const profitPerLbLt = totalLbs > 0 ? totalProfit / totalLbs : 0;
  const netPerLb = totalLbs > 0 ? netSales / totalLbs : 0;
  const marginPctLt = netSales > 0 ? (totalProfit / netSales) * 100 : 0;
  /** Lifetime “net profit” on the hub: tax-incl sales minus all recorded expenses (simple cash-style headline). */
  const netAfterExpensesLt = salesTaxIncl - expenseTotalLt;
  const expenseRatioPctLt = netSales > 0 ? (expenseOperatingForPnlLt / netSales) * 100 : 0;

  let invoiceRecordsPaid = 0;
  for (const inv of invoices) {
    const st = String(inv?.payment?.status || "").toUpperCase();
    if (st === "PAID") invoiceRecordsPaid += 1;
  }

  const dashboardLifetimeStats = {
    totalOrderRows: orders.length,
    activeOrders,
    cancelledOrders,
    pendingPipeline,
    fulfilled,
    paidOrders,
    uniqueCustomersWithOrders: customerIds.size,
    totalLbs,
    salesTaxIncl,
    netSales,
    taxCollected,
    totalCogs,
    totalProfit,
    expenseTotal: expenseTotalLt,
    expenseOperatingForPnl: expenseOperatingForPnlLt,
    expenseEntryCount: expenses.length,
    expenseByCategory: expenseByCategoryLt,
    topItems,
    avgOrderTaxIncl,
    profitPerLb: profitPerLbLt,
    netPerLb,
    marginPct: marginPctLt,
    netAfterExpenses: netAfterExpensesLt,
    expenseRatioPct: expenseRatioPctLt,
    invoicesOnOrders,
    invoicedAmount,
    invoiceRecordsCount: invoices.length,
    invoiceRecordsPaid,
    inventoryLotCount: inventory.length,
    recipeCount: recipes.length,
    ingredientCount: ingredients.length,
    customerRecordsCount: customers.length
  };

  return {
    reportSummary,
    dashboardWeekly,
    dashboardPeriodBounds,
    dashboardPeriodLbsByRecipe,
    dashboardLeaderboards,
    dashboardLifetimeStats
  };
}

function numFromTotals(totals: Record<string, unknown> | undefined, key: string): number {
  if (!totals || typeof totals !== "object") return NaN;
  const v = totals[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Prefer native Calculator sheet formulas (`action=totals`) for headline $ / counts when present.
 * Calculator revenue / order counts exclude CANCELLED (same as hub order loops). We do not overwrite
 * totalOrderRows — that stays `orders.length` from the pull (includes cancelled rows for audit).
 */
export function overlayLifetimeStatsFromCalculatorTotals<
  T extends ReturnType<typeof computeDashboardAnalytics>
>(analytics: T, totals: Record<string, unknown> | null | undefined): T {
  if (!totals || typeof totals !== "object") return analytics;
  const ls = { ...analytics.dashboardLifetimeStats } as Record<string, unknown>;

  const setIf = (outKey: string, calcKey: string) => {
    const v = numFromTotals(totals, calcKey);
    if (Number.isFinite(v)) ls[outKey] = v;
  };

  {
    const revTot = numFromTotals(totals, "snapshot_revenue_tax_incl_total");
    if (Number.isFinite(revTot)) ls.salesTaxIncl = revTot;
    else {
      const revAlt = numFromTotals(totals, "snapshot_revenue_tax_incl");
      if (Number.isFinite(revAlt)) ls.salesTaxIncl = revAlt;
    }
  }
  setIf("netSales", "snapshot_revenue_pre_tax_total");
  setIf("taxCollected", "snapshot_sales_tax_estimated");
  setIf("avgOrderTaxIncl", "snapshot_avg_order_value_tax_incl");
  setIf("expenseTotal", "snapshot_expense_total");
  setIf("expenseEntryCount", "snapshot_expense_rows_count");
  setIf("recipeCount", "snapshot_products_count");
  setIf("ingredientCount", "snapshot_ingredients_count");
  setIf("inventoryLotCount", "snapshot_ingredient_inv_rows");
  setIf("customerRecordsCount", "snapshot_customers_count");

  const netSales = Number(ls.netSales ?? 0);
  const totalProfit = Number(ls.totalProfit ?? 0);
  const totalCogs = Number(ls.totalCogs ?? 0);
  const opEx = Number(ls.expenseOperatingForPnl ?? 0);
  if (Number.isFinite(netSales) && netSales > 0) {
    ls.marginPct = (totalProfit / netSales) * 100;
    ls.expenseRatioPct = (opEx / netSales) * 100;
  }
  const netSalesHeadline = Number(ls.netSales ?? 0);
  const expenseAll = Number(ls.expenseTotal ?? 0);
  if (Number.isFinite(netSalesHeadline) && Number.isFinite(expenseAll)) {
    ls.netAfterExpenses = netSalesHeadline - expenseAll;
  }
  const salesInclHeadline = Number(ls.salesTaxIncl ?? 0);
  const activeOrd = Number(ls.activeOrders ?? 0);
  if (salesInclHeadline > 0 && activeOrd > 0) {
    ls.avgOrderTaxIncl = salesInclHeadline / activeOrd;
  }
  const totalLbs = Number(ls.totalLbs ?? 0);
  if (totalLbs > 0) {
    ls.profitPerLb = totalProfit / totalLbs;
    ls.netPerLb = netSales / totalLbs;
  }

  return { ...analytics, dashboardLifetimeStats: ls };
}
