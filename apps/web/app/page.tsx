"use client";

import {
  type CSSProperties,
  type ReactNode,
  type WheelEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { getPublicApiBase } from "../lib/api-base";
import { downloadWithAuth } from "../lib/auth-token";
import { apiDelete, apiGet, apiGetWithQuery, apiPost, apiPostForm, apiPut } from "../lib/api-request";
import {
  calendarAddDaysYmd,
  calendarDateInWeek,
  calendarEndOfWeekSaturday,
  calendarMonthGridCells,
  calendarStartOfWeekSunday,
  workersCalendarAppsScriptRange
} from "../lib/calendar-date-utils";
import {
  appsScriptEventToWorkersClientEvent,
  createJrWorkersCalendarEvent,
  deleteJrWorkersCalendarEvent,
  jrWorkersCalendarAppsScriptConfigured,
  listJrWorkersCalendarEvents,
  localDateTimeValue,
  toISOFromLocalDatetimeInput,
  updateJrWorkersCalendarEvent,
  type WorkersCalendarClientRow
} from "../lib/jr-workers-calendar-apps-script";
import { formatRecipeRatioForInput, normalizeRecipeRatioPercent, parseRecipeRatioInput } from "../lib/recipe-ratio-utils";
import { useSheetMutationQueue } from "./sheet-mutation-queue";

/** Stop page scroll when the wheel happens on the dimmed backdrop (not on modal content). */
function preventModalBackdropWheel(e: WheelEvent<HTMLDivElement>) {
  if (e.target === e.currentTarget) e.preventDefault();
}

function filterKickbackPaymentsByPaidDate(rows: any[], from: string, to: string) {
  const f0 = String(from || "").trim();
  const t0 = String(to || "").trim();
  if (!f0 && !t0) return rows;
  return rows.filter((p) => {
    const d = new Date(String(p.paidAt || p.createdAt || ""));
    if (Number.isNaN(d.getTime())) return true;
    if (f0) {
      const f = new Date(f0 + "T00:00:00");
      if (d < f) return false;
    }
    if (t0) {
      const t = new Date(t0 + "T23:59:59.999");
      if (d > t) return false;
    }
    return true;
  });
}

function sumKickbackPaid(rows: any[]) {
  return rows.reduce((s, p) => s + Number(p.amountPaid || 0), 0);
}

/** Plain-language lines for confirmation dialogs (avoid raw JSON). */
function formatConfirmHumanLines(value: unknown, indent = 0): string[] {
  const pad = "  ".repeat(indent);
  if (value === undefined || value === null) return [`${pad}(nothing)`];
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return [`${pad}(empty)`];
    if (t.includes("\n")) return t.split("\n").map((line) => `${pad}${line}`);
    return [`${pad}${t}`];
  }
  if (typeof value === "number") return [`${pad}${value}`];
  if (typeof value === "boolean") return [`${pad}${value ? "Yes" : "No"}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}(none)`];
    const out: string[] = [];
    for (const v of value) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        out.push(...formatConfirmHumanLines(v, indent));
      } else {
        out.push(`${pad}• ${String(v)}`);
      }
    }
    return out;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const labelFor = (k: string) => {
      const map: Record<string, string> = {
        orderId: "Order ID",
        paid: "Marked as paid",
        pickedUp: "Picked up",
        PickedUp: "Picked up",
        paymentMethod: "Payment method",
        paymentStatus: "Payment status",
        note: "Note",
        notes: "Note",
        summary: "Summary",
        orders: "Orders",
        customerName: "Customer name",
        customerEmail: "Email",
        customerPhone: "Phone",
        customer: "Customer",
        Customer: "Customer",
        product: "Product",
        subtotal: "Subtotal",
        invoice: "Invoice",
        items: "Items",
        lbs: "Weight (lb)",
        cogs: "COGS",
        amount: "Amount",
        Amount: "Amount",
        status: "Status"
      };
      return map[k] || k.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim();
    };
    const keys = Object.keys(o);
    if (keys.length === 0) return [`${pad}(empty)`];
    const out: string[] = [];
    for (const k of keys) {
      const v = o[k];
      if (v === undefined) continue;
      const lk = labelFor(k);
      if (typeof v === "boolean") out.push(`${pad}${lk}: ${v ? "Yes" : "No"}`);
      else if (typeof v === "string" || typeof v === "number") out.push(`${pad}${lk}: ${v}`);
      else if (Array.isArray(v)) {
        out.push(`${pad}${lk}`);
        for (const line of v) out.push(`${pad}  • ${String(line)}`);
      } else if (typeof v === "object" && v !== null) {
        out.push(`${pad}${lk}`);
        out.push(...formatConfirmHumanLines(v, indent + 1));
      } else out.push(`${pad}${lk}: ${String(v)}`);
    }
    return out.length ? out : [`${pad}(empty)`];
  }
  return [`${pad}${String(value)}`];
}

/** True when the order is already fully paid (sheet + API view). */
function isPendingOrderPaid(o: any): boolean {
  return Boolean(o?.paidAt) || String(o?.paymentStatus || "").toUpperCase() === "PAID";
}

function resolvedPendingPaymentMethod(o: any, pendingPaymentMethodByOrder: Record<string, string>): string {
  return String(pendingPaymentMethodByOrder[o.id] ?? o.paymentMethod ?? "").trim();
}

function pendingOrderDraftDiff(
  o: any,
  orderNoteById: Record<string, string>,
  pendingPaymentMethodByOrder: Record<string, string>
) {
  const draftNote = String(orderNoteById[o.id] ?? o.notes ?? "").trim();
  const savedNote = String(o.notes ?? "").trim();
  const draftPm = String(pendingPaymentMethodByOrder[o.id] ?? o.paymentMethod ?? "").trim();
  const savedPm = String(o.paymentMethod ?? "").trim();
  return {
    draftNote,
    savedNote,
    draftPm,
    savedPm,
    dirty: draftNote !== savedNote || draftPm !== savedPm
  };
}

const tabs = [
  "Dashboard",
  "Customers",
  "Products",
  "Inventory",
  "Submit Order",
  "Making",
  "Pending Orders",
  "Archive Orders",
  "Expenses",
  "Sales",
  "Profit",
  "Tax",
  "Invoices",
  "Coupons & Co-ops",
  "Notes",
  "Calendar",
  "Calculator",
  "Reports"
] as const;
type Tab = (typeof tabs)[number];
const taxFriendlyExpenseCategories = [
  "Inventory - Meat",
  "Inventory - Organ",
  "Inventory - Dairy",
  "Inventory - Produce",
  "Inventory - Supplements",
  "Packaging",
  "Shipping/Delivery",
  "Equipment",
  "Utilities",
  "Rent",
  "Marketing",
  "Insurance",
  "Professional Fees",
  "Payroll/Contractors",
  "Other"
];
/** Default card for business expenses; shown first in quick-picks. */
const DEFAULT_EXPENSE_PAYMENT_METHOD = "Mastercard 6507";
const paymentMethodOptions = [DEFAULT_EXPENSE_PAYMENT_METHOD, "Credit Card", "Zelle", "Cash", "Venmo"] as const;

/** Browser autocomplete + quick chips; field stays free-text (any vendor allowed). */
const EXPENSE_VENDOR_DATALIST_ID = "hub-expense-vendor-suggestions";
const commonExpenseVendors = ["Amazon", "Restaurant Depot", "Home Depot", "Cake Fiction/rent"] as const;

async function apiGetRecipes(): Promise<any[]> {
  return apiGet<any[]>("/operations/recipes");
}

type InvoiceBuilderLine = { description: string; quantity: string; unitPrice: string };
type LocalNote = { id: string; text: string; createdAt: string };
type LocalCalendarEvent = {
  id: string;
  title: string;
  date: string;
  note: string;
  time?: string;
  reminderAt?: string;
  done?: boolean;
  doneAt?: string;
};

type CalendarSourceMode = "local" | "workers" | "both";

type WorkersIcsClientEvent = WorkersCalendarClientRow;

type CalendarListItem = { source: "local"; event: LocalCalendarEvent } | { source: "workers"; event: WorkersIcsClientEvent };

function calendarItemDate(item: CalendarListItem): string {
  return item.source === "local" ? item.event.date : item.event.date;
}

function calendarItemTime(item: CalendarListItem): string {
  return item.source === "local" ? (item.event.time || "").trim() : (item.event.time || "").trim();
}

function calendarItemSortKey(item: CalendarListItem): string {
  const t = calendarItemTime(item);
  return t.length >= 5 ? t.slice(0, 5) : "00:00";
}

function normalizeCalendarEvents(raw: unknown): LocalCalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x: any) => ({
    id: String(x.id || crypto.randomUUID()),
    title: String(x.title || ""),
    date: String(x.date || new Date().toISOString().slice(0, 10)).slice(0, 10),
    note: String(x.note ?? ""),
    time: x.time != null && String(x.time).trim() ? String(x.time).slice(0, 5) : "",
    reminderAt: x.reminderAt ? String(x.reminderAt) : "",
    done: Boolean(x.done),
    doneAt: x.doneAt ? String(x.doneAt) : ""
  }));
}

/** Dashboard KPI drill-down (popup detail). */
type DashboardDrill =
  | { type: "customers" }
  | { type: "customers-activity" }
  | { type: "orders-all" }
  | { type: "expenses-all" }
  | { type: "expenses-period" }
  | { type: "recipes-all" }
  | { type: "ingredients-all" }
  | { type: "inventory-lots" }
  | { type: "invoices-all" }
  | { type: "invoices-paid" }
  | { type: "orders-money-period" }
  | { type: "orders-money-lifetime" }
  | { type: "orders-active-period" }
  | { type: "orders-active-lifetime" }
  | { type: "orders-cancelled-period" }
  | { type: "orders-cancelled-lifetime" }
  | { type: "orders-pending-lifetime" }
  | { type: "orders-fulfilled-lifetime" }
  | { type: "orders-paid-lifetime" }
  | { type: "orders-with-invoice-lifetime" }
  | { type: "lbs-recipe-period" }
  | { type: "lbs-recipe-lifetime" }
  | { type: "net-after-period" }
  | { type: "net-after-lifetime" }
  | { type: "pnl-books" }
  | { type: "week"; label: string; startIso: string; endIso: string };
type DepreciationAsset = {
  id: string;
  placedInService: string;
  vendor: string;
  assetName: string;
  category: string;
  payment: string;
  account: string;
  paidAmount: number;
  depreciableBasis: number;
  method: string;
  section179: boolean;
  recoveryYears: number;
  /** Depreciation already taken before this app / DB (matches old spreadsheet through cutover). */
  priorAccumulated?: number;
};

/**
 * Extra lifetime totals when history lived in another sheet and was never fully imported.
 * Keep at zero when the API already returns the full sheet (SHEET_ONLY / Google Sheet source of truth)
 * so dashboard KPIs are not double-counted.
 */
const LIFETIME_PRIOR_SALES_TAX_INCL = 0;
const LIFETIME_PRIOR_TOTAL_LBS = 0;
const LIFETIME_PRIOR_EXPENSES = 0;
const LIFETIME_PRIOR_COGS = 0;
const NJ_TAX_INCLUDED_DIVISOR = 1 + 0.06625;
const LIFETIME_PRIOR_NET_SALES = LIFETIME_PRIOR_SALES_TAX_INCL / NJ_TAX_INCLUDED_DIVISOR;
const LIFETIME_PRIOR_TAX_COLLECTED = LIFETIME_PRIOR_SALES_TAX_INCL - LIFETIME_PRIOR_NET_SALES;
const fmtMoney = (value: unknown) => {
  let n = Number(value || 0);
  if (!Number.isFinite(n)) n = 0;
  // Avoid displaying "-0.00" for tiny floating point noise.
  if (Math.abs(n) < 0.005) n = 0;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const moneyColor = (value: unknown) => (Number(value ?? 0) >= 0 ? "green" : "crimson");
const localDateTimeInputValue = (d = new Date()) => {
  const tzOffset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
};
const normalizeExpenseDateInput = (value: string) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
};
/** Strip to digits only — used so "5551234" matches "(555) 123-4567". */
const phoneDigitsOnly = (s: string) => String(s || "").replace(/\D/g, "");
/** Legacy Create-sheet style: salmon oil scaled to pumps (~4 ml per pump). Matches Apps Script JR_SALMON_OIL_PUMPS_PER_LB. */
const JR_SALMON_OIL_PUMPS_PER_LB = 113.398;
/** Hide Making shopping / batch lines when computed need or batch share is effectively zero. */
const MAKING_MIN_LB = 1e-9;
function makingNeedLbsPositive(lbs: unknown): boolean {
  return Number(lbs || 0) > MAKING_MIN_LB;
}
function formatMakingIngredientQtyLabel(ingredientName: string, lbs: number): string {
  const n = String(ingredientName || "").toLowerCase();
  if (n.includes("salmon") && n.includes("oil")) return `${Math.round(lbs * JR_SALMON_OIL_PUMPS_PER_LB)} pumps`;
  return lbs.toFixed(2);
}
type MakingPrintPreviewRow = { recipeName: string; batchLabel: string; pairs: Array<{ name: string; qty: string }> };
/** Same grouping as Apps Script jrRefreshMakingPrint_ (horizontal print rows). */
function buildMakingPrintPreviewRows(batchPlanAuto: any[] | undefined): MakingPrintPreviewRow[] {
  const rows = Array.isArray(batchPlanAuto) ? batchPlanAuto : [];
  type Agg = { recipeName: string; batchNo: number; batchLbs: number; pairs: Array<{ name: string; lbs: number }> };
  const order: string[] = [];
  const map = new Map<string, Agg>();
  for (const r of rows) {
    const recipeId = String(r.recipeId || "").trim();
    const recipeName = String(r.recipeName || "").trim();
    const batchNo = Number(r.batchNo || 0);
    const batchLbs = Number(r.batchLbs || 0);
    const ing = String(r.ingredientName || "").trim();
    const ilbs = Number(r.ingredientLbs || 0);
    if (!recipeId || !ing || !makingNeedLbsPositive(ilbs)) continue;
    const k = `${recipeId}\t${batchNo}`;
    if (!map.has(k)) {
      map.set(k, { recipeName, batchNo, batchLbs, pairs: [] });
      order.push(k);
    }
    map.get(k)!.pairs.push({ name: ing, lbs: ilbs });
  }
  const nbByRid: Record<string, number> = {};
  for (const k of order) {
    const rid = k.split("\t")[0];
    nbByRid[rid] = (nbByRid[rid] || 0) + 1;
  }
  const out: MakingPrintPreviewRow[] = [];
  let prevRid: string | null = null;
  for (const k of order) {
    const ent = map.get(k)!;
    const rid = k.split("\t")[0];
    if (prevRid !== null && rid !== prevRid) {
      out.push({ recipeName: "", batchLabel: "", pairs: [] });
    }
    prevRid = rid;
    const label =
      (nbByRid[rid] || 0) <= 1 ? `${ent.batchLbs.toFixed(2)} lbs` : `Batch ${ent.batchNo} – ${ent.batchLbs.toFixed(2)} lbs`;
    const pairs = ent.pairs
      .filter((p) => makingNeedLbsPositive(p.lbs))
      .map((p) => ({ name: p.name, qty: formatMakingIngredientQtyLabel(p.name, p.lbs) }));
    out.push({ recipeName: ent.recipeName, batchLabel: label, pairs });
  }
  return out;
}
/** Same list as /reports P&L — ingredient-category expenses are inventory, not extra operating expense (COGS already includes product cost). */
const PNL_INVENTORY_PURCHASE_EXPENSE_CATEGORIES = new Set(
  ["Meats", "Organs", "Dairy", "Fruits/Veggies", "Fruits / Veggies", "Fats", "Supplements", "Packaging"].map((c) => c.toLowerCase())
);
function isPnlInventoryPurchaseExpenseCategory(raw: unknown): boolean {
  const c = String(raw ?? "").trim().toLowerCase();
  return c.length > 0 && PNL_INVENTORY_PURCHASE_EXPENSE_CATEGORIES.has(c);
}

function hydrateDashboardAnalytics(raw: any) {
  const lb = raw.dashboardLeaderboards;
  const hydrateWeek = (w: any) =>
    w
      ? {
          ...w,
          start: new Date(w.startIso),
          end: new Date(w.endIso)
        }
      : null;
  return {
    reportSummary: {
      ...raw.reportSummary,
      fromDate: raw.reportSummary.fromDateIso ? new Date(raw.reportSummary.fromDateIso) : null,
      toDate: raw.reportSummary.toDateIso ? new Date(raw.reportSummary.toDateIso) : null
    },
    dashboardWeekly: {
      ...raw.dashboardWeekly,
      buckets: raw.dashboardWeekly.buckets.map((b: any) => ({
        ...b,
        start: new Date(b.startIso),
        end: new Date(b.endIso)
      }))
    },
    dashboardPeriodBounds: {
      rangeStart: new Date(raw.dashboardPeriodBounds.rangeStartIso),
      rangeEnd: new Date(raw.dashboardPeriodBounds.rangeEndIso)
    },
    dashboardPeriodLbsByRecipe: raw.dashboardPeriodLbsByRecipe,
    dashboardLeaderboards: {
      bestWeekNet: hydrateWeek(lb.bestWeekNet),
      bestWeekGross: hydrateWeek(lb.bestWeekGross),
      bestWeekLbs: hydrateWeek(lb.bestWeekLbs),
      bestWeekSales: hydrateWeek(lb.bestWeekSales),
      bestMonthNet: lb.bestMonthNet,
      bestMonthGross: lb.bestMonthGross,
      bestMonthLbs: lb.bestMonthLbs,
      bestMonthSales: lb.bestMonthSales
    },
    dashboardLifetimeStats: raw.dashboardLifetimeStats
  };
}

const EMPTY_REPORT_SUMMARY = {
  fromDate: null as Date | null,
  toDate: null as Date | null,
  ordersInRangeCount: 0,
  cancelledOrderCount: 0,
  expenseCount: 0,
  orderTotals: { orders: 0, lbs: 0, salesTaxIncl: 0, netSales: 0, taxCollected: 0, cogs: 0, profit: 0 },
  expenseTotal: 0,
  expenseOperatingForPnl: 0,
  expenseByCategory: [] as { category: string; total: number }[],
  items: [] as Array<{ item: string; orders: number; lbs: number; salesTaxIncl: number; netSales: number; profit: number }>,
  avgOrderValue: 0,
  profitPerLb: 0,
  netAfterExpenses: 0,
  marginPct: 0,
  expenseRatioPct: 0,
  topCustomer: null as [string, number] | null
};

type DashboardWeekBucketUi = {
  start: Date;
  end: Date;
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

const EMPTY_DASHBOARD_WEEKLY: {
  buckets: DashboardWeekBucketUi[];
  totals: {
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
  maxSales: number;
  maxProfit: number;
  maxExpenses: number;
  weeksBack: 8 | 12 | 26;
  lineScaleMax: number;
} = {
  buckets: [],
  totals: { salesTaxIncl: 0, netSales: 0, taxCollected: 0, cogs: 0, profit: 0, expenses: 0, orders: 0, lbs: 0, cancelled: 0 },
  maxSales: 1,
  maxProfit: 1,
  maxExpenses: 1,
  weeksBack: 8,
  lineScaleMax: 1
};

const EMPTY_LEADERBOARDS = {
  bestWeekNet: null as any,
  bestWeekGross: null as any,
  bestWeekLbs: null as any,
  bestWeekSales: null as any,
  bestMonthNet: null as any,
  bestMonthGross: null as any,
  bestMonthLbs: null as any,
  bestMonthSales: null as any
};

const EMPTY_LIFETIME_STATS = {
  totalOrderRows: 0,
  activeOrders: 0,
  cancelledOrders: 0,
  pendingPipeline: 0,
  fulfilled: 0,
  paidOrders: 0,
  uniqueCustomersWithOrders: 0,
  totalLbs: 0,
  salesTaxIncl: 0,
  netSales: 0,
  taxCollected: 0,
  totalCogs: 0,
  totalProfit: 0,
  expenseTotal: 0,
  expenseOperatingForPnl: 0,
  expenseEntryCount: 0,
  expenseByCategory: [] as { category: string; total: number }[],
  topItems: [] as Array<{ item: string; orders: number; lbs: number; salesTaxIncl: number; netSales: number; profit: number }>,
  avgOrderTaxIncl: 0,
  profitPerLb: 0,
  netPerLb: 0,
  marginPct: 0,
  netAfterExpenses: 0,
  expenseRatioPct: 0,
  invoicesOnOrders: 0,
  invoicedAmount: 0,
  invoiceRecordsCount: 0,
  invoiceRecordsPaid: 0,
  inventoryLotCount: 0,
  recipeCount: 0,
  ingredientCount: 0,
  customerRecordsCount: 0
};
/**
 * Match on name OR email OR phone (any field is enough). Phone compares digit strings so formatting doesn't matter.
 */
function customerMatchesLookupQuery(c: any, rawQuery: string): boolean {
  const trimmed = rawQuery.trim();
  if (!trimmed) return false;
  const qLower = trimmed.toLowerCase();
  const qDigits = phoneDigitsOnly(trimmed);
  const name = String(c.name || "").toLowerCase();
  const email = String(c.email || "").toLowerCase();
  const phone = String(c.phone || "");
  const phoneDigits = phoneDigitsOnly(phone);
  if (name.includes(qLower)) return true;
  if (email.includes(qLower)) return true;
  if (phone.toLowerCase().includes(qLower)) return true;
  if (qDigits.length >= 1 && phoneDigits.length >= 1 && phoneDigits.includes(qDigits)) return true;
  return false;
}
/** Reuse existing customer when phone (digits) or email matches to avoid duplicates. */
function findCustomerForOrder(customers: any[], phone: string, email: string): any | null {
  const em = email.trim().toLowerCase();
  if (em) {
    const byEmail = customers.find((c: any) => String(c.email || "").trim().toLowerCase() === em);
    if (byEmail) return byEmail;
  }
  const pd = phoneDigitsOnly(phone);
  if (pd.length >= 10) {
    const exact = customers.find((c: any) => phoneDigitsOnly(c.phone || "") === pd);
    if (exact) return exact;
  }
  if (pd.length >= 7) {
    return (
      customers.find((c: any) => {
        const cd = phoneDigitsOnly(c.phone || "");
        if (!cd) return false;
        return cd.endsWith(pd) || pd.endsWith(cd);
      }) || null
    );
  }
  return null;
}
const toDateInput = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const parseMmDdYyyy = (value: string) => {
  const [mm, dd, yyyy] = value.split("/").map((x) => Number(x));
  if (!mm || !dd || !yyyy) return new Date();
  return new Date(yyyy, mm - 1, dd);
};
const seededDepreciationAssets: DepreciationAsset[] = [
  {
    id: "dep-1",
    placedInService: "4/16/2025",
    vendor: "Amazon",
    assetName: "4KW Meat Grinder",
    category: "Equipment",
    payment: "Personal credit card",
    account: "Amazon",
    paidAmount: 1166.47,
    depreciableBasis: 1166.47,
    method: "Section 179",
    section179: true,
    recoveryYears: 7,
    priorAccumulated: 1166.47
  },
  {
    id: "dep-2",
    placedInService: "6/10/2025",
    vendor: "Facebook marketplace",
    assetName: "Chest Freezer 1",
    category: "Equipment",
    payment: "Personal cash",
    account: "NA",
    paidAmount: 500,
    depreciableBasis: 500,
    method: "Section 179",
    section179: true,
    recoveryYears: 7,
    priorAccumulated: 500
  },
  {
    id: "dep-3",
    placedInService: "6/12/2025",
    vendor: "Facebook marketplace",
    assetName: "Chest Freezer 2",
    category: "Equipment",
    payment: "Personal cash",
    account: "NA",
    paidAmount: 500,
    depreciableBasis: 500,
    method: "Section 179",
    section179: true,
    recoveryYears: 7,
    priorAccumulated: 500
  },
  {
    id: "dep-4",
    placedInService: "7/3/2025",
    vendor: "Facebook marketplace",
    assetName: "Hobart 4346 Grinder Mixer",
    category: "Equipment",
    payment: "Business checking",
    account: "TD Checking",
    paidAmount: 4800,
    depreciableBasis: 4800,
    method: "Section 179",
    section179: true,
    recoveryYears: 7,
    priorAccumulated: 4800
  },
  {
    id: "dep-5",
    placedInService: "4/13/2025",
    vendor: "Gift",
    assetName: "45 Quart Industrial Prepline Mixer",
    category: "Equipment",
    payment: "NA",
    account: "NA",
    paidAmount: 0,
    depreciableBasis: 4000,
    method: "Section 179",
    section179: true,
    recoveryYears: 7,
    priorAccumulated: 4000
  }
];

function SignedMoney({ value }: { value: unknown }) {
  const n = Number(value ?? 0);
  return <span style={{ color: moneyColor(n) }}>${fmtMoney(n)}</span>;
}

function PctColored({ value }: { value: unknown }) {
  const n = Number(value ?? 0);
  return <span style={{ color: moneyColor(n) }}>{n.toFixed(2)}%</span>;
}

export default function HomePage() {
  const { enqueueMutation, readOnlyLoading, setReadOnlyLoading, isOrderSheetBusy } = useSheetMutationQueue();
  /** Stack so overlapping sheet waits (e.g. initial load + tab refresh) do not hide the modal too soon. */
  const sheetWaitStackRef = useRef<string[]>([]);
  const pushSheetWait = useCallback(
    (label: string) => {
      sheetWaitStackRef.current.push(label);
      setReadOnlyLoading(label);
    },
    [setReadOnlyLoading]
  );
  const popSheetWait = useCallback(() => {
    sheetWaitStackRef.current.pop();
    const s = sheetWaitStackRef.current;
    setReadOnlyLoading(s.length > 0 ? s[s.length - 1]! : null);
  }, [setReadOnlyLoading]);
  const categoryOrder = ["Meats", "Organs", "Dairy", "Fruits/Veggies", "Fats", "Supplements", "Packaging", "Uncategorized"];
  const blankRecipeLines = [{ ingredientName: "", quantity: "" }];
  const blankBundleLines = [{ ingredientId: "", quantity: "" }];
  const [activeTab, setActiveTab] = useState<Tab>("Dashboard");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState<Record<string, number>>({});
  const [pnl, setPnl] = useState<Record<string, number>>({});
  const [calculatorData, setCalculatorData] = useState<any>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [ingredients, setIngredients] = useState<any[]>([]);
  const [recipes, setRecipes] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [hubDashboard, setHubDashboard] = useState<ReturnType<typeof hydrateDashboardAnalytics> | null>(null);
  const hubBootstrapReadyRef = useRef(false);
  const hubDashboardParamsSkipFirst = useRef(true);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [promoCodes, setPromoCodes] = useState<any[]>([]);
  const [coopSummary, setCoopSummary] = useState<
    {
      promoCodeId: string;
      code: string;
      label: string;
      payeeNotes: string | null;
      orderCount: number;
      kickbackOwed: number;
      revenueTaxIncl: number;
      kickbackPaid?: number;
      kickbackOutstanding?: number;
      lastKickbackPaidAt?: string | null;
    }[]
  >([]);
  const [kickbackPayments, setKickbackPayments] = useState<any[]>([]);
  const [kickbackPayForm, setKickbackPayForm] = useState({
    paidAt: "",
    periodFrom: "",
    periodTo: "",
    promoCode: "",
    promoLabel: "",
    amountPaid: "",
    notes: ""
  });
  const [kickbackPaidFilter, setKickbackPaidFilter] = useState({ from: "", to: "" });
  const [newPromoForm, setNewPromoForm] = useState({
    code: "",
    label: "",
    kind: "COUPON" as "COUPON" | "COOP",
    discountPercent: "",
    discountFixed: "",
    kickbackPercent: "",
    kickbackFixed: "",
    payeeNotes: "",
    active: true
  });
  const [editingPromo, setEditingPromo] = useState<any | null>(null);

  const [ingredientForm, setIngredientForm] = useState({
    name: "",
    category: "Meats",
    unit: "lb",
    quantityOnHand: "",
    totalCost: "",
    percentAdded: ""
  });
  const [ingredientPurchaseForm, setIngredientPurchaseForm] = useState({ ingredientId: "", addedQuantity: "", addedCost: "" });
  const [ingredientPurchaseSearch, setIngredientPurchaseSearch] = useState("");
  const [ingredientSearch, setIngredientSearch] = useState("");
  const [ingredientEditRows, setIngredientEditRows] = useState<Record<string, { quantityOnHand: string; totalCost: string }>>({});
  const [recipeForm, setRecipeForm] = useState({
    name: "",
    description: "",
    foodType: "Adult",
    costPerPound: "",
    salePrice: "",
    chargeUnit: "lb",
    amountPerUnit: "1",
    isBundle: false
  });
  const [recipeLines, setRecipeLines] = useState(blankRecipeLines);
  const [bundleLines, setBundleLines] = useState(blankBundleLines);
  const [editingRecipeId, setEditingRecipeId] = useState("");
  const [recipeSaveNotice, setRecipeSaveNotice] = useState<string>("");
  const [recipeSubmitting, setRecipeSubmitting] = useState(false);
  const [recipeSearch, setRecipeSearch] = useState("");
  const [recipeFoodTypeFilter, setRecipeFoodTypeFilter] = useState<"ALL" | "Adult" | "Puppy" | "Specialty" | "Treats">("ALL");
  const [recipeSortBy, setRecipeSortBy] = useState<"margin" | "name" | "costPerPound" | "salePrice" | "unit" | "amountPerUnit" | "foodType">("name");
  const [recipeSortDirection, setRecipeSortDirection] = useState<"asc" | "desc">("asc");
  const [inventoryForm, setInventoryForm] = useState({ ingredient: "", quantityLbs: "", unitCost: "", receivedAt: new Date().toISOString().slice(0, 10) });
  const [submitOrderForm, setSubmitOrderForm] = useState({
    name: "",
    phone: "",
    email: "",
    address: "",
    recipeId: "",
    quantityLbs: "",
    notes: "",
    paymentMethod: "",
    promoCode: ""
  });
  const [submitOrderItems, setSubmitOrderItems] = useState<Array<{ recipeId: string; quantityLbs: number }>>([]);
  const [submitOrderPromoCheck, setSubmitOrderPromoCheck] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [makingLines, setMakingLines] = useState<Array<{ recipeId: string; amountLbs: string }>>([{ recipeId: "", amountLbs: "" }]);
  const [makingPlanNotes, setMakingPlanNotes] = useState("");
  const [makingPlanSaveHint, setMakingPlanSaveHint] = useState<string | null>(null);
  const [makingCompute, setMakingCompute] = useState<any | null>(null);
  /** Sheet-driven snapshot (Making + *_Auto tabs); multiple recipes / lbs read from the same engine the sheet uses. */
  const [makingEngine, setMakingEngine] = useState<any | null>(null);
  const [makingComputeBusy, setMakingComputeBusy] = useState(false);
  const [makingApplyBusy, setMakingApplyBusy] = useState(false);
  const [pendingPaymentMethodByOrder, setPendingPaymentMethodByOrder] = useState<Record<string, string>>({});
  /** Inline validation for pending order payment actions (e.g. must pick payment method). */
  const [pendingOrderActionErrorByOrder, setPendingOrderActionErrorByOrder] = useState<Record<string, string>>({});
  /** Submit Order: payment method required — show under field. */
  const [submitOrderPaymentMethodError, setSubmitOrderPaymentMethodError] = useState<string>("");
  /** Search on Pending Orders tab (JR Workers pick / pay view). */
  const [jrWorkerPickupsSearch, setJrWorkerPickupsSearch] = useState("");
  const [partialAmountByOrder, setPartialAmountByOrder] = useState<Record<string, string>>({});
  const [editingOrderId, setEditingOrderId] = useState("");
  const [orderEditForm, setOrderEditForm] = useState({
    customerName: "",
    customerEmail: "",
    customerPhone: ""
  });
  const [orderEditItems, setOrderEditItems] = useState<Array<{ recipeId: string; quantityLbs: string }>>([{ recipeId: "", quantityLbs: "" }]);
  const [expenseForm, setExpenseForm] = useState<{
    vendor: string;
    description: string;
    category: string;
    amount: string;
    payment: string;
    receiptPath: string;
    expenseDate: string;
  }>({
    vendor: "",
    description: "",
    category: "",
    amount: "",
    payment: DEFAULT_EXPENSE_PAYMENT_METHOD,
    receiptPath: "",
    expenseDate: localDateTimeInputValue()
  });
  /** Queued until expense row exists; then uploaded to Google Drive (Apps Script) with searchable names. */
  const [expensePendingReceiptFiles, setExpensePendingReceiptFiles] = useState<File[]>([]);
  const expensePendingReceiptFilesRef = useRef<File[]>([]);
  const [editingExpenseId, setEditingExpenseId] = useState("");
  const [expenseEditForm, setExpenseEditForm] = useState({
    vendor: "",
    description: "",
    category: "",
    amount: "",
    expenseDate: "",
    payment: "",
    receiptPath: ""
  });
  const [expenseReceiptPreview, setExpenseReceiptPreview] = useState<{ href: string; isPdf: boolean; name: string } | null>(null);
  const [invoiceForm, setInvoiceForm] = useState({ orderId: "", invoiceNumber: "", amount: "" });
  const [markPaidForm, setMarkPaidForm] = useState({ invoiceId: "", amount: "", status: "PAID" });
  const [invoiceBuilder, setInvoiceBuilder] = useState({
    orderId: "",
    invoiceNumber: "",
    invoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    billToName: "",
    billToEmail: "",
    billToPhone: "",
    billToAddress: "",
    notes: "Thank you for supporting Jersey Raw.",
    taxRate: "6.625",
    discount: "0"
  });
  const [invoiceLines, setInvoiceLines] = useState<InvoiceBuilderLine[]>([{ description: "Dog food order", quantity: "1", unitPrice: "" }]);
  const [expenseFilter, setExpenseFilter] = useState({
    from: "",
    to: "",
    query: "",
    category: ""
  });
  const [expenseSubTab, setExpenseSubTab] = useState<"expenses" | "depreciation">("expenses");
  const [dashboardWeeksBack, setDashboardWeeksBack] = useState<8 | 12 | 26>(8);
  const [dashboardChartType, setDashboardChartType] = useState<"bar" | "line">("bar");
  const [dashboardLifetimeOpen, setDashboardLifetimeOpen] = useState(false);
  const [dashboardDrill, setDashboardDrill] = useState<DashboardDrill | null>(null);
  const [expenseBreakdown, setExpenseBreakdown] = useState<any>({ total: 0, count: 0, byCategory: [], rows: [] });
  const [financeRange, setFinanceRange] = useState({ from: "", to: "" });
  const [reportPreset, setReportPreset] = useState<"week" | "month" | "custom">("week");
  const [reportRange, setReportRange] = useState(() => {
    const now = new Date();
    const from = new Date(now);
    from.setDate(now.getDate() - 6);
    return { from: toDateInput(from), to: toDateInput(now) };
  });
  const [salesSummary, setSalesSummary] = useState<any>({});
  const [profitSummary, setProfitSummary] = useState<any>({});
  const [taxSummary, setTaxSummary] = useState<any>({});
  const [njTaxRate, setNjTaxRate] = useState("0.06625");
  const [archiveOrderDraft, setArchiveOrderDraft] = useState("");
  const [archiveOrderSearch, setArchiveOrderSearch] = useState("");
  const [archiveSearchLoading, setArchiveSearchLoading] = useState(false);
  const [archiveInvoiceBackfillMsg, setArchiveInvoiceBackfillMsg] = useState<string | null>(null);
  const [invoiceRegenerateMsg, setInvoiceRegenerateMsg] = useState<string | null>(null);
  const [customerLookupDraft, setCustomerLookupDraft] = useState("");
  const [customerLookupQuery, setCustomerLookupQuery] = useState("");
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [selectedCustomerLookupId, setSelectedCustomerLookupId] = useState("");
  const [orderNoteById, setOrderNoteById] = useState<Record<string, string>>({});
  const [confirmModal, setConfirmModal] = useState<{ title: string; from?: unknown; to?: unknown } | null>(null);
  const [calendarPreviewItem, setCalendarPreviewItem] = useState<CalendarListItem | null>(null);
  const anyModalOpen =
    Boolean(dashboardDrill) || Boolean(confirmModal) || Boolean(expenseReceiptPreview) || Boolean(calendarPreviewItem);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const [noteInput, setNoteInput] = useState("");
  const [notesList, setNotesList] = useState<LocalNote[]>([]);
  const [calendarInput, setCalendarInput] = useState({
    title: "",
    date: new Date().toISOString().slice(0, 10),
    time: "",
    note: "",
    reminderAt: ""
  });
  const [calendarEvents, setCalendarEvents] = useState<LocalCalendarEvent[]>([]);
  const [calendarView, setCalendarView] = useState<"week" | "month">("month");
  const [calendarSourceMode, setCalendarSourceMode] = useState<CalendarSourceMode>(() => {
    const fallback = jrWorkersCalendarAppsScriptConfigured() ? "workers" : "both";
    if (typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem("jr-calendar-source-mode");
      if (raw === "local" || raw === "workers" || raw === "both") return raw;
    } catch {
      /* ignore */
    }
    return fallback;
  });
  const [workersIcs, setWorkersIcs] = useState<WorkersIcsClientEvent[]>([]);
  const [workersIcsMeta, setWorkersIcsMeta] = useState<{ pathTried: string; fileCount: number; warning?: string } | null>(
    null
  );
  const [workersIcsLoading, setWorkersIcsLoading] = useState(false);
  const [workersIcsError, setWorkersIcsError] = useState<string | null>(null);
  const [workersIcsRefreshNonce, setWorkersIcsRefreshNonce] = useState(0);
  const [calendarWeekAnchor, setCalendarWeekAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [calendarMonthPickDay, setCalendarMonthPickDay] = useState<string | null>(null);
  const [calendarEditingId, setCalendarEditingId] = useState<string | null>(null);
  const [calendarEditDraft, setCalendarEditDraft] = useState({
    title: "",
    date: "",
    time: "",
    note: "",
    reminderAt: ""
  });
  const [workersCalInput, setWorkersCalInput] = useState({
    kind: "task" as "task" | "event",
    title: "",
    whenStart: "",
    whenEnd: "",
    location: "",
    description: ""
  });
  const [workersCalEditingId, setWorkersCalEditingId] = useState<string | null>(null);
  const [workersCalSaving, setWorkersCalSaving] = useState(false);
  const calendarReminderFiredRef = useRef<Set<string>>(new Set());

  const calendarMergedItems = useMemo((): CalendarListItem[] => {
    const localItems: CalendarListItem[] = calendarEvents.map((event) => ({ source: "local", event }));
    const workerItems: CalendarListItem[] = workersIcs.map((event) => ({ source: "workers", event }));
    if (calendarSourceMode === "local") return localItems;
    if (calendarSourceMode === "workers") return workerItems;
    return [...localItems, ...workerItems];
  }, [calendarEvents, workersIcs, calendarSourceMode]);

  const calendarFilteredItems = useMemo(() => {
    const sorted = [...calendarMergedItems].sort((a, b) => {
      const ta = calendarItemSortKey(a).padStart(5, "0");
      const tb = calendarItemSortKey(b).padStart(5, "0");
      const c1 = calendarItemDate(a).localeCompare(calendarItemDate(b));
      if (c1 !== 0) return c1;
      return ta.localeCompare(tb);
    });
    if (calendarView === "week") return sorted.filter((it) => calendarDateInWeek(calendarItemDate(it), calendarWeekAnchor));
    if (calendarView === "month") {
      const list = sorted.filter((it) => calendarItemDate(it).startsWith(calendarMonth));
      if (calendarMonthPickDay) return list.filter((it) => calendarItemDate(it) === calendarMonthPickDay);
      return list;
    }
    return sorted;
  }, [calendarMergedItems, calendarView, calendarWeekAnchor, calendarMonth, calendarMonthPickDay]);

  const calendarWeekLabel = useMemo(() => {
    const ws = calendarStartOfWeekSunday(calendarWeekAnchor);
    const we = calendarEndOfWeekSaturday(calendarWeekAnchor);
    return `${ws.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} – ${we.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}`;
  }, [calendarWeekAnchor]);

  const invoiceCalc = useMemo(() => {
    const subtotal = invoiceLines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
    const discount = Number(invoiceBuilder.discount || 0);
    const taxable = Math.max(0, subtotal - discount);
    const tax = taxable * (Number(invoiceBuilder.taxRate || 0) / 100);
    const total = taxable + tax;
    return { subtotal, discount, taxable, tax, total };
  }, [invoiceLines, invoiceBuilder.discount, invoiceBuilder.taxRate]);

  const pendingOrders = useMemo(
    () =>
      [...orders]
        .filter((o: any) => o.status === "NEW" || o.status === "CONFIRMED")
        .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [orders]
  );

  const splitAroundFifty = useCallback((totalLbs: number): number[] => {
    const total = Math.max(0, Number(totalLbs || 0));
    if (!(total > 0)) return [];
    if (total <= 60) return [Number(total.toFixed(2))];
    const batchCount = Math.max(2, Math.round(total / 50));
    const base = Number((total / batchCount).toFixed(2));
    const out: number[] = [];
    let used = 0;
    for (let i = 0; i < batchCount - 1; i++) {
      out.push(base);
      used += base;
    }
    out.push(Number((total - used).toFixed(2)));
    return out;
  }, []);

  const parseOrderItemLines = useCallback(
    (o: any): Array<{ recipeName: string; recipeId: string; quantityLbs: number }> => {
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
            r.qLbsField > 0 &&
            r.qUnit === "lb" &&
            (r.qRaw <= 0 || Math.abs(r.qRaw - r.qLbsField) < 1e-6);

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
              return (r.qRaw / taxDiv) / r.unitPrice;
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
        // fallback below
      }
      const fallback = String(o?.recipe?.name || recipes.find((r: any) => r.id === o?.recipeId)?.name || "").trim();
      const lbs = Number(o?.quantityLbs || 0);
      const fid = String(o?.recipeId || "").trim();
      if (fallback && lbs > 0) return [{ recipeName: fallback, recipeId: fid, quantityLbs: lbs }];
      return [];
    },
    [recipes]
  );

  const makingDemandByRecipe = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of pendingOrders) {
      const lines = parseOrderItemLines(o);
      for (const line of lines) {
        map.set(line.recipeName, (map.get(line.recipeName) || 0) + Number(line.quantityLbs || 0));
      }
    }
    return [...map.entries()]
      .map(([recipeName, lbs]) => ({ recipeName, lbs: Number(lbs.toFixed(2)) }))
      .sort((a, b) => b.lbs - a.lbs);
  }, [pendingOrders, parseOrderItemLines]);

  const makingManualDemandByRecipe = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of makingLines) {
      const rid = String(line.recipeId || "").trim();
      const lbs = Number(line.amountLbs || 0);
      if (!rid || !(lbs > 0)) continue;
      const recipe = recipes.find((r: any) => r.id === rid);
      if (!recipe) continue;
      const name = String(recipe.name || "").trim();
      if (!name) continue;
      map.set(name, (map.get(name) || 0) + lbs);
    }
    return [...map.entries()].map(([recipeName, lbs]) => ({ recipeName, lbs: Number(lbs.toFixed(2)) }));
  }, [makingLines, recipes]);

  const makingRecipeBookDemandByRecipeId = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of makingLines) {
      const rid = String(line.recipeId || "").trim();
      const lbs = Number(line.amountLbs || 0);
      if (!rid || !(lbs > 0)) continue;
      map.set(rid, (map.get(rid) || 0) + lbs);
    }
    return [...map.entries()]
      .map(([recipeId, lbs]) => ({ recipeId, lbs: Number(lbs.toFixed(2)) }))
      .sort((a, b) => b.lbs - a.lbs);
  }, [makingLines]);

  const makingCombinedDemandByRecipe = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of makingDemandByRecipe) map.set(row.recipeName, (map.get(row.recipeName) || 0) + row.lbs);
    for (const row of makingManualDemandByRecipe) map.set(row.recipeName, (map.get(row.recipeName) || 0) + row.lbs);
    return [...map.entries()]
      .map(([recipeName, lbs]) => ({ recipeName, lbs: Number(lbs.toFixed(2)) }))
      .sort((a, b) => b.lbs - a.lbs);
  }, [makingDemandByRecipe, makingManualDemandByRecipe]);

  const makingRecipeBook = useMemo(() => {
    return makingRecipeBookDemandByRecipeId
      .map((row) => {
        const recipe = recipes.find((r: any) => r.id === row.recipeId);
        if (!recipe) return null;
        const batches = splitAroundFifty(row.lbs);
        const ingredientPairs = (recipe.ingredients || [])
          .map((ri: any) => {
            const name = String(ri?.ingredient?.name || "").trim();
            const ratioPct = normalizeRecipeRatioPercent(ri?.quantity);
            const unit = String(ri?.ingredient?.unit || "lb").trim() || "lb";
            if (!name || !(ratioPct > 0)) return null;
            return { name, ratioPct, unit };
          })
          .filter(Boolean) as Array<{ name: string; ratioPct: number; unit: string }>;
        return {
          recipeId: recipe.id,
          recipeName: String(recipe.name || "Unknown recipe"),
          totalLbs: row.lbs,
          batches,
          ingredientPairs
        };
      })
      .filter(Boolean) as Array<{
      recipeId: string;
      recipeName: string;
      totalLbs: number;
      batches: number[];
      ingredientPairs: Array<{ name: string; ratioPct: number; unit: string }>;
    }>;
  }, [makingRecipeBookDemandByRecipeId, recipes, splitAroundFifty]);

  const makingShoppingList = useMemo(() => {
    const byIngredient = new Map<string, { ingredientName: string; needLbs: number; onHandLbs: number; buyLbs: number }>();
    // Shopping list follows Recipe Book scope: manual make lines only.
    for (const row of makingRecipeBookDemandByRecipeId) {
      const recipe = recipes.find((r: any) => r.id === row.recipeId);
      if (!recipe) continue;
      const recipeLbs = Number(row.lbs || 0);
      for (const ri of recipe.ingredients || []) {
        const ingredientName = String(ri?.ingredient?.name || "").trim();
        if (!ingredientName) continue;
        const ratioPct = normalizeRecipeRatioPercent(ri?.quantity);
        const needed = (ratioPct / 100) * recipeLbs;
        const onHand = Number(ri?.ingredient?.quantityOnHand || 0);
        const cur = byIngredient.get(ingredientName) || { ingredientName, needLbs: 0, onHandLbs: onHand, buyLbs: 0 };
        cur.needLbs += needed;
        // keep latest onHand snapshot (same ingredient likely same value anyway)
        cur.onHandLbs = onHand;
        byIngredient.set(ingredientName, cur);
      }
    }
    const rows = [...byIngredient.values()]
      .map((x) => {
        const need = Number(x.needLbs.toFixed(2));
        const onHand = Number(x.onHandLbs.toFixed(2));
        const buy = Number(Math.max(0, need - onHand).toFixed(2));
        return { ingredientName: x.ingredientName, needLbs: need, onHandLbs: onHand, buyLbs: buy };
      })
      .filter((a) => makingNeedLbsPositive(a.needLbs))
      .sort((a, b) => b.buyLbs - a.buyLbs || b.needLbs - a.needLbs);
    return rows;
  }, [makingRecipeBookDemandByRecipeId, recipes]);

  const makingEngineRecipePlans = useMemo(() => {
    const rows = makingEngine?.batchPlanAuto;
    if (!Array.isArray(rows) || !rows.length) return [];
    const byR = new Map<
      string,
      { recipeId: string; recipeName: string; batchMap: Map<number, number> }
    >();
    for (const r of rows) {
      const rid = String(r.recipeId || "").trim();
      if (!rid) continue;
      if (!byR.has(rid))
        byR.set(rid, { recipeId: rid, recipeName: String(r.recipeName || ""), batchMap: new Map() });
      const bn = Number(r.batchNo);
      const bl = Number(r.batchLbs);
      if (bn > 0 && bl > 0) byR.get(rid)!.batchMap.set(bn, bl);
    }
    return [...byR.values()].map((x) => {
      const order = [...x.batchMap.keys()].sort((a, b) => a - b);
      const batches = order.map((k) => x.batchMap.get(k) || 0);
      const totalLbs = batches.reduce((s, v) => s + v, 0);
      return { recipeId: x.recipeId, recipeName: x.recipeName, totalLbs, batches };
    });
  }, [makingEngine]);

  const displayRecipePlansForApply = useMemo(() => {
    if (Array.isArray(makingCompute?.recipePlans) && makingCompute.recipePlans.length) return makingCompute.recipePlans;
    return makingEngineRecipePlans;
  }, [makingCompute, makingEngineRecipePlans]);

  const displayShoppingRows = useMemo(() => {
    const sa = makingEngine?.shoppingAuto;
    if (Array.isArray(sa) && sa.length > 0) {
      return sa
        .map((r: any) => ({
          ingredientName: String(r.ingredientName || ""),
          needLbs: Number(r.neededLbs || 0),
          onHandLbs: Number(r.onHandLbs || 0),
          buyLbs: Number(r.buyLbs || 0)
        }))
        .filter((r) => makingNeedLbsPositive(r.needLbs));
    }
    return makingShoppingList;
  }, [makingEngine, makingShoppingList]);

  const makingPrintPreviewRows = useMemo(
    () => buildMakingPrintPreviewRows(makingEngine?.batchPlanAuto),
    [makingEngine?.batchPlanAuto]
  );

  const displayIngredientTotalsFromCompute = useMemo(() => {
    const rows = Array.isArray(makingCompute?.ingredientTotals) && makingCompute.ingredientTotals.length
      ? makingCompute.ingredientTotals
      : displayShoppingRows.map((r) => ({
          ingredientName: r.ingredientName,
          needLbs: r.needLbs,
          onHandLbs: r.onHandLbs,
          buyLbs: r.buyLbs
        }));
    return rows.filter((r: any) => makingNeedLbsPositive(r.needLbs ?? r.neededLbs));
  }, [makingCompute, displayShoppingRows]);

  const archiveOrders = useMemo(
    () =>
      [...orders]
        .filter((o: any) => o.status === "FULFILLED" || o.status === "CANCELLED")
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [orders]
  );
  const filteredArchiveOrders = useMemo(() => {
    const q = archiveOrderSearch.trim().toLowerCase();
    if (!q) return archiveOrders;
    return archiveOrders.filter((o: any) => {
      const date = new Date(o.createdAt).toLocaleDateString().toLowerCase();
      const fields = [
        o.id,
        o.customer?.name,
        o.customer?.phone,
        o.customer?.email,
        o.status,
        o.invoice?.invoiceNumber,
        o.invoice?.pdfPath,
        String(Number(o.subtotal || 0).toFixed(2)),
        date
      ]
        .map((v) => String(v || "").toLowerCase())
        .join(" ");
      return fields.includes(q);
    });
  }, [archiveOrders, archiveOrderSearch]);
  const orderMetrics = (o: any) => {
    const lines = parseOrderItemLines(o);
    let lbs = Number(o?.quantityLbs || 0);
    if (!(lbs > 0)) {
      lbs = lines.reduce((s, l) => s + Number(l.quantityLbs || 0), 0);
    }
    const subtotal = Number(o?.subtotalTaxIncl ?? o?.subtotal ?? 0); // tax-included total
    const preTaxNet = Number(o?.preTaxNet || 0);
    const salesTax = subtotal > 0 ? subtotal - (preTaxNet > 0 ? preTaxNet : subtotal / 1.06625) : 0;
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
    const profitTotal = hasStoredProfit ? storedProfit : (cogs > 0 ? netRevenue - cogs : 0);
    const pricePerLb = lbs > 0 ? netRevenue / lbs : 0;
    let profitPerLb = 0;
    if (lbs > 0) {
      if (hasStoredProfit) profitPerLb = profitTotal / lbs;
      else if (hasStoredProfitPerLb) profitPerLb = storedProfitPerLb;
      else profitPerLb = profitTotal / lbs;
    }
    return { lbs, subtotal, salesTax, netRevenue, cogs, profitTotal, pricePerLb, profitPerLb };
  };
  useEffect(() => {
    if (reportPreset === "custom") return;
    const now = new Date();
    if (reportPreset === "week") {
      const from = new Date(now);
      from.setDate(now.getDate() - 6);
      setReportRange({ from: toDateInput(from), to: toDateInput(now) });
      return;
    }
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    setReportRange({ from: toDateInput(monthStart), to: toDateInput(now) });
  }, [reportPreset]);

  const reportSummary = hubDashboard?.reportSummary ?? EMPTY_REPORT_SUMMARY;
  const dashboardWeekly: typeof EMPTY_DASHBOARD_WEEKLY = hubDashboard?.dashboardWeekly ?? EMPTY_DASHBOARD_WEEKLY;
  const dashboardPeriodBounds =
    hubDashboard?.dashboardPeriodBounds ?? { rangeStart: new Date(0), rangeEnd: new Date(0) };
  const dashboardLeaderboards = hubDashboard?.dashboardLeaderboards ?? EMPTY_LEADERBOARDS;
  const dashboardPeriodLbsByRecipe: Array<{ recipe: string; lbs: number }> =
    hubDashboard?.dashboardPeriodLbsByRecipe ?? [];
  const dashboardLifetimeStats = hubDashboard?.dashboardLifetimeStats ?? EMPTY_LIFETIME_STATS;
  const openDashboardWeekDrill = useCallback((w: { start: Date; end: Date; label: string }) => {
    setDashboardDrill({
      type: "week",
      label: w.label,
      startIso: w.start.toISOString(),
      endIso: w.end.toISOString()
    });
  }, []);
  const depreciationRows = useMemo(() => {
    const now = new Date();
    return seededDepreciationAssets.map((asset) => {
      const start = parseMmDdYyyy(asset.placedInService);
      const lifeMonths = asset.recoveryYears * 12;
      const monthsElapsed = Math.max(
        0,
        Math.min(
          lifeMonths,
          (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + (now.getDate() >= start.getDate() ? 0 : -1)
        )
      );
      const yearlyDepreciation = asset.depreciableBasis / Math.max(1, asset.recoveryYears);
      const monthlyDepreciation = yearlyDepreciation / 12;
      const prior = Math.max(0, Number(asset.priorAccumulated ?? 0));
      const remaining = Math.max(0, asset.depreciableBasis - prior);
      const scheduleOnRemaining = Math.min(remaining, monthlyDepreciation * monthsElapsed);
      const accumulated = Math.min(asset.depreciableBasis, prior + scheduleOnRemaining);
      const bookValue = asset.depreciableBasis - accumulated;
      return { ...asset, yearlyDepreciation, monthlyDepreciation, accumulated, bookValue, monthsElapsed };
    });
  }, []);
  const depreciationSummary = useMemo(
    () =>
      depreciationRows.reduce(
        (acc, row) => {
          acc.paidAmount += row.paidAmount;
          acc.depreciableBasis += row.depreciableBasis;
          acc.yearlyDepreciation += row.yearlyDepreciation;
          acc.monthlyDepreciation += row.monthlyDepreciation;
          acc.accumulated += row.accumulated;
          acc.bookValue += row.bookValue;
          return acc;
        },
        { paidAmount: 0, depreciableBasis: 0, yearlyDepreciation: 0, monthlyDepreciation: 0, accumulated: 0, bookValue: 0 }
      ),
    [depreciationRows]
  );
  const selectedSubmitOrderRecipe = useMemo(
    () => recipes.find((r: any) => r.id === submitOrderForm.recipeId),
    [recipes, submitOrderForm.recipeId]
  );
  const submitOrderItemRows = useMemo(() => {
    return submitOrderItems
      .map((item) => {
        const recipe = recipes.find((r: any) => r.id === item.recipeId);
        return recipe ? { ...item, recipe } : null;
      })
      .filter(Boolean) as Array<{ recipeId: string; quantityLbs: number; recipe: any }>;
  }, [submitOrderItems, recipes]);
  const submitOrderCalc = useMemo(() => {
    let lbs = 0;
    let netRevenue = 0;
    let cogs = 0;
    for (const row of submitOrderItemRows) {
      const recipe = row.recipe;
      const unit = String(recipe?.chargeUnit ?? "lb");
      const amountPerUnit = Math.max(0.01, Number(recipe?.amountPerUnit ?? 1));
      const chargePerLb = unit === "bag" ? Number(recipe?.salePrice || 0) / amountPerUnit : Number(recipe?.salePrice || 0);
      const costPerLb = Number(recipe?.costPerPound || 0);
      lbs += Number(row.quantityLbs || 0);
      netRevenue += Number(row.quantityLbs || 0) * chargePerLb;
      cogs += Number(row.quantityLbs || 0) * costPerLb;
    }
    const salesTax = netRevenue * 0.06625;
    const subtotalInclTax = netRevenue + salesTax;
    const margin = netRevenue - cogs;
    return { lbs, chargePerLb: 0, costPerLb: 0, netRevenue, salesTax, subtotalInclTax, cogs, margin };
  }, [submitOrderItemRows]);

  /** Matches sheet: any code can use %/$ off pre-tax and %/$ kickback on pre-tax merchandise (kickback on pre-discount base). */
  const submitOrderPromoPreview = useMemo(() => {
    const base = submitOrderCalc;
    const code = (submitOrderForm.promoCode || "").trim().toUpperCase();
    const promo = promoCodes.find((x: any) => x.active && String(x.code || "").toUpperCase() === code);
    const nj = 0.06625;
    const baseNet = base.netRevenue;
    if (!promo || !(baseNet > 0)) {
      return {
        matched: null as any,
        netRevenue: baseNet,
        salesTax: base.salesTax,
        subtotalInclTax: base.subtotalInclTax,
        cogs: base.cogs,
        discountPreTax: 0,
        coopKickback: 0
      };
    }
    const pct = Number(promo.discountPercent || 0);
    const fix = Number(promo.discountFixed || 0);
    let discountPreTax = 0;
    if (pct > 0) discountPreTax += (baseNet * pct) / 100;
    if (fix > 0) discountPreTax += fix;
    discountPreTax = Math.min(baseNet, Math.max(0, discountPreTax));
    const kp = Number(promo.kickbackPercent || 0);
    const kf = Number(promo.kickbackFixed || 0);
    const coopKickback = Math.max(0, (baseNet * kp) / 100 + kf);
    const netAfter = Math.max(0, baseNet - discountPreTax);
    const salesTax = netAfter * nj;
    const subtotalInclTax = netAfter + salesTax;
    return {
      matched: promo,
      netRevenue: netAfter,
      salesTax,
      subtotalInclTax,
      cogs: base.cogs,
      discountPreTax,
      coopKickback
    };
  }, [submitOrderCalc, submitOrderForm.promoCode, promoCodes]);

  const orderEditTotals = useMemo(() => {
    const lines = orderEditItems
      .map((line) => {
        const recipe = recipes.find((r: any) => r.id === line.recipeId);
        const lbs = Number(line.quantityLbs || 0);
        if (!recipe || !(lbs > 0)) return null;
        const pricePerLb =
          recipe.chargeUnit === "bag"
            ? Number(recipe.salePrice || 0) / Math.max(0.01, Number(recipe.amountPerUnit || 1))
            : Number(recipe.salePrice || 0);
        const cogsPerLb = Number(recipe.costPerPound || 0);
        return { lbs, pricePerLb, cogsPerLb };
      })
      .filter(Boolean) as Array<{ lbs: number; pricePerLb: number; cogsPerLb: number }>;
    const lbs = lines.reduce((s, x) => s + x.lbs, 0);
    const netRevenue = lines.reduce((s, x) => s + x.lbs * x.pricePerLb, 0);
    const salesTax = netRevenue * 0.06625;
    const subtotal = netRevenue + salesTax;
    const cogs = lines.reduce((s, x) => s + x.lbs * x.cogsPerLb, 0);
    const margin = netRevenue - cogs;
    return { lbs, pricePerLb: lbs > 0 ? netRevenue / lbs : 0, cogsPerLb: lbs > 0 ? cogs / lbs : 0, netRevenue, salesTax, subtotal, cogs, margin };
  }, [orderEditItems, recipes]);
  const pendingOrderRowColor = (o: any) => {
    const partial = String(o?.paymentStatus || "").toUpperCase() === "PARTIAL";
    const paid = Boolean(o?.paidAt) || String(o?.paymentStatus || "").toUpperCase() === "PAID";
    const pickedUp = Boolean(o?.pickedUpAt);
    if (partial) return "#f3e8ff"; // purple
    if (pickedUp && !paid) return "#ffe3e3"; // red
    if (paid) return "#e6f7ea"; // green
    return "#fff6cc"; // yellow
  };
  const pendingSummary = useMemo(() => {
    return pendingOrders.reduce(
      (acc: any, o: any) => {
        const m = orderMetrics(o);
        acc.orders += 1;
        acc.lbs += m.lbs;
        acc.revenue += m.subtotal;
        acc.netRevenue += m.netRevenue;
        acc.salesTax += m.salesTax;
        acc.profit += m.profitTotal;
        return acc;
      },
      { orders: 0, lbs: 0, revenue: 0, netRevenue: 0, salesTax: 0, profit: 0 }
    );
  }, [pendingOrders]);
  const archiveSummary = useMemo(() => {
    return filteredArchiveOrders.reduce(
      (acc: any, o: any) => {
        const m = orderMetrics(o);
        acc.orders += 1;
        acc.lbs += m.lbs;
        acc.revenue += m.subtotal;
        acc.netRevenue += m.netRevenue;
        acc.salesTax += m.salesTax;
        acc.profit += m.profitTotal;
        return acc;
      },
      { orders: 0, lbs: 0, revenue: 0, netRevenue: 0, salesTax: 0, profit: 0 }
    );
  }, [filteredArchiveOrders]);
  /** Customers with at least one archived/completed order. */
  const customerIdsFromArchiveOrders = useMemo(() => {
    const ids = new Set<string>();
    for (const o of orders) {
      const s = String(o.status || "");
      if (s === "FULFILLED" || s === "CANCELLED" || s === "PICKED_UP") {
        if (o.customerId) ids.add(o.customerId);
      }
    }
    return ids;
  }, [orders]);
  const customerSearchSuggestions = useMemo(() => {
    const raw = customerLookupDraft;
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const qLower = trimmed.toLowerCase();
    const qDigits = phoneDigitsOnly(trimmed);
    return customers
      .filter((c: any) => customerIdsFromArchiveOrders.has(c.id) && customerMatchesLookupQuery(c, raw))
      .map((c: any) => {
        const name = String(c.name || "");
        const email = String(c.email || "");
        const phone = String(c.phone || "");
        const phoneDigits = phoneDigitsOnly(phone);
        let score = 0;
        if (name.toLowerCase().startsWith(qLower)) score += 100;
        else if (name.toLowerCase().includes(qLower)) score += 50;
        if (email.toLowerCase().startsWith(qLower)) score += 45;
        else if (email.toLowerCase().includes(qLower)) score += 25;
        if (qDigits.length >= 1) {
          if (phoneDigits.startsWith(qDigits)) score += 95;
          else if (phoneDigits.includes(qDigits)) score += 55;
        }
        return { customer: c, score };
      })
      .sort((a: any, b: any) => b.score - a.score || String(a.customer.name || "").localeCompare(String(b.customer.name || "")))
      .slice(0, 20);
  }, [customerLookupDraft, customers, customerIdsFromArchiveOrders]);
  const customerLookupRows = useMemo(() => {
    const raw = customerLookupQuery;
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }
    const qLower = trimmed.toLowerCase();
    const qDigits = phoneDigitsOnly(trimmed);
    const matches = customers.filter((c: any) => customerIdsFromArchiveOrders.has(c.id) && customerMatchesLookupQuery(c, raw));
    const ranked = matches
      .map((c: any) => {
        const name = String(c.name || "").toLowerCase();
        const email = String(c.email || "").toLowerCase();
        const phone = String(c.phone || "");
        const phoneDigits = phoneDigitsOnly(phone);
        let score = 0;
        if (name.startsWith(qLower)) score += 100;
        else if (name.includes(qLower)) score += 50;
        if (email.startsWith(qLower)) score += 45;
        else if (email.includes(qLower)) score += 25;
        if (qDigits.length >= 1) {
          if (phoneDigits.startsWith(qDigits)) score += 95;
          else if (phoneDigits.includes(qDigits)) score += 55;
        }
        if (phone.toLowerCase().includes(qLower)) score += 30;
        return { c, score };
      })
      .sort((a, b) => b.score - a.score || String(a.c.name || "").localeCompare(String(b.c.name || "")));
    return ranked.map(({ c }) => ({
      customer: c,
      orders: orders
        .filter((o: any) => o.customerId === c.id)
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }));
  }, [customerLookupQuery, customers, orders, customerIdsFromArchiveOrders]);
  const archiveSearchSuggestions = useMemo(() => {
    const q = archiveOrderDraft.trim().toLowerCase();
    if (!q) return [];
    const qDigits = phoneDigitsOnly(q);
    return archiveOrders
      .filter((o: any) => {
        const fields = [
          String(o.id || ""),
          String(o.customerName || o.customer?.name || ""),
          String(o.phone || o.customer?.phone || ""),
          String(o.email || o.customer?.email || ""),
          String(o.status || ""),
          String(o.invoice?.invoiceNumber || ""),
          String(Number(o.subtotal || 0).toFixed(2))
        ];
        const blob = fields.join(" ").toLowerCase();
        const phoneDigits = phoneDigitsOnly(String(o.phone || o.customer?.phone || ""));
        if (qDigits) return blob.includes(q) || phoneDigits.includes(qDigits);
        return blob.includes(q);
      })
      .slice(0, 20)
      .map((o: any) => ({
        id: String(o.id || ""),
        name: String(o.customerName || o.customer?.name || "Unknown"),
        phone: String(o.phone || o.customer?.phone || ""),
        email: String(o.email || o.customer?.email || ""),
        invoice: String(o.invoice?.invoiceNumber || ""),
        total: Number(o.subtotal || 0)
      }));
  }, [archiveOrderDraft, archiveOrders]);

  const selectedCustomerAggregate = useMemo(() => {
    if (!selectedCustomerLookupId) return null;
    const list = orders.filter((o: any) => o.customerId === selectedCustomerLookupId);
    let orderCount = 0;
    let totalLbs = 0;
    let totalTaxIncl = 0;
    let netSales = 0;
    let salesTax = 0;
    let totalCogs = 0;
    let totalProfit = 0;
    let pending = 0;
    let fulfilled = 0;
    let cancelled = 0;
    let invoicesCount = 0;
    let invoicedAmount = 0;
    for (const o of list) {
      orderCount += 1;
      const m = orderMetrics(o);
      totalLbs += m.lbs;
      totalTaxIncl += m.subtotal;
      netSales += m.netRevenue;
      salesTax += m.salesTax;
      totalCogs += m.cogs;
      totalProfit += m.profitTotal;
      if (o.status === "CANCELLED") cancelled += 1;
      else if (o.status === "FULFILLED") fulfilled += 1;
      else pending += 1;
      if (o.invoice) {
        invoicesCount += 1;
        invoicedAmount += Number(o.invoice?.amount || 0);
      }
    }
    const profitPerLb = totalLbs > 0 ? totalProfit / totalLbs : 0;
    const netPerLb = totalLbs > 0 ? netSales / totalLbs : 0;
    const avgOrderTaxIncl = orderCount > 0 ? totalTaxIncl / orderCount : 0;
    const marginPctOfNet = netSales > 0 ? (totalProfit / netSales) * 100 : 0;
    return {
      orderCount,
      totalLbs,
      totalTaxIncl,
      netSales,
      salesTax,
      totalCogs,
      totalProfit,
      profitPerLb,
      netPerLb,
      avgOrderTaxIncl,
      marginPctOfNet,
      pending,
      fulfilled,
      cancelled,
      invoicesCount,
      invoicedAmount
    };
  }, [selectedCustomerLookupId, orders]);

  const selectedCustomerRecord = useMemo(
    () => customers.find((c: any) => c.id === selectedCustomerLookupId) || null,
    [customers, selectedCustomerLookupId]
  );

  async function runCustomerSearch(queryInput: string) {
    const q = queryInput.trim();
    setCustomerSearchLoading(true);
    setSelectedCustomerLookupId("");
    try {
      // Refresh only Customers-tab data so results are current.
      await refreshActiveTabData("Customers");
      setCustomerLookupQuery(q);
    } finally {
      setCustomerSearchLoading(false);
    }
  }

  async function runArchiveSearch(queryInput: string) {
    const q = queryInput.trim();
    setArchiveSearchLoading(true);
    try {
      await refreshActiveTabData("Archive Orders");
      setArchiveOrderSearch(q);
    } finally {
      setArchiveSearchLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedCustomerLookupId) return;
    const stillHere = customerLookupRows.some((r: any) => r.customer.id === selectedCustomerLookupId);
    if (!stillHere) setSelectedCustomerLookupId("");
  }, [customerLookupRows, selectedCustomerLookupId]);

  const rows = useMemo(
    () => ({
      customers,
      ingredients,
      recipes,
      inventory,
      orders,
      expenses,
      invoices
    }),
    [customers, ingredients, recipes, inventory, orders, expenses, invoices]
  );
  const ingredientsByCategory = useMemo(() => {
    const q = ingredientSearch.toLowerCase().trim();
    const filtered = ingredients.filter((item: any) => {
      if (!q) return true;
      const blob = `${item.name || ""} ${item.category || ""} ${item.vendor || ""}`.toLowerCase();
      return blob.includes(q);
    });
    const grouped = filtered.reduce((acc: Record<string, any[]>, item: any) => {
      const key = item.category || "Uncategorized";
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    }, {});
    const ordered: Record<string, any[]> = {};
    for (const cat of categoryOrder) {
      if (grouped[cat]) ordered[cat] = grouped[cat];
    }
    for (const [cat, items] of Object.entries(grouped)) {
      if (!ordered[cat]) ordered[cat] = items;
    }
    return ordered;
  }, [ingredients, ingredientSearch]);
  const ingredientById = useMemo(() => {
    const map: Record<string, any> = {};
    for (const ing of ingredients) map[ing.id] = ing;
    return map;
  }, [ingredients]);
  const ingredientByNameLower = useMemo(() => {
    const map: Record<string, any> = {};
    for (const ing of ingredients) {
      const k = String(ing.name ?? "").trim().toLowerCase();
      if (k) map[k] = ing;
    }
    return map;
  }, [ingredients]);
  const recipeById = useMemo(() => {
    const map: Record<string, any> = {};
    for (const recipe of recipes) map[recipe.id] = recipe;
    return map;
  }, [recipes]);

  const getRecipeUnitCost = (recipe: any) => Number(recipe?.costPerPound || 0) * Math.max(0.01, Number(recipe?.amountPerUnit || 1));
  const getRecipeUnitCharge = (recipe: any) => Number(recipe?.salePrice || 0);
  const recipeComputedCostPerLb = useCallback(
    (recipe: any) => {
      const lines = (recipe?.ingredients || []).map((ri: any) => {
        const pctRaw = Number(ri?.quantity || 0);
            const pct = pctRaw;
        const cost = Number(ri?.ingredient?.pricePerLb ?? ingredientById[ri?.ingredientId]?.pricePerLb ?? 0);
        return { pct: Number.isFinite(pct) ? pct : 0, cost: Number.isFinite(cost) ? cost : 0 };
      });
      const weighted = lines.reduce((sum: number, x: any) => sum + (x.pct / 100) * x.cost, 0);
      return Number(weighted.toFixed(4));
    },
    [ingredientById]
  );

  const resolveIngredientRow = useCallback(
    (rawName: string) => {
      const name = String(rawName || "").trim();
      if (!name) return null;
      return ingredientById[name] ?? ingredientByNameLower[name.toLowerCase()] ?? null;
    },
    [ingredientById, ingredientByNameLower]
  );

  const recipeCalculator = useMemo(() => {
    const parsed = recipeLines
      .filter((line) => line.ingredientName.trim() && parseRecipeRatioInput(line.quantity) > 0)
      .map((line) => {
        const raw = parseRecipeRatioInput(line.quantity);
        const pct = raw;
        const ing = resolveIngredientRow(line.ingredientName);
        return { ingredientName: line.ingredientName.trim(), percent: Number.isFinite(pct) ? pct : 0, ing };
      })
      .filter((x) => x.percent > 0);

    const totalPercent = parsed.reduce((sum, x) => sum + x.percent, 0);
    const weightedCost = parsed.reduce((sum, x) => {
      return sum + (x.percent / 100) * Number(x.ing?.pricePerLb ?? 0);
    }, 0);
    const weightedCharge = parsed.reduce((sum, x) => {
      return sum + (x.percent / 100) * Number(x.ing?.chargePerPound ?? 0);
    }, 0);
    const bundleCost = bundleLines
      .filter((line) => line.ingredientId && line.quantity)
      .reduce((sum, line) => {
        const child = recipeById[line.ingredientId];
        return sum + getRecipeUnitCost(child) * Number(line.quantity || 0);
      }, 0);
    const bundleCharge = bundleLines
      .filter((line) => line.ingredientId && line.quantity)
      .reduce((sum, line) => {
        const child = recipeById[line.ingredientId];
        return sum + getRecipeUnitCharge(child) * Number(line.quantity || 0);
      }, 0);
    return {
      lineCount: parsed.length,
      totalPercent,
      weightedCost,
      weightedCharge,
      bundleCost,
      bundleCharge
    };
  }, [recipeLines, resolveIngredientRow, bundleLines, recipeById]);
  const recipePercentDeltaTo100 = useMemo(() => Number((100 - recipeCalculator.totalPercent).toFixed(2)), [recipeCalculator.totalPercent]);
  const filteredRecipes = useMemo(() => {
    const q = recipeSearch.trim().toLowerCase();
    const baseSearched = !q
      ? rows.recipes
      : rows.recipes.filter((r: any) => {
          const recipeName = String(r.name ?? "").toLowerCase();
          const desc = String(r.description ?? "").toLowerCase();
          const mixText = (r.ingredients || [])
            .map((ri: any) => `${ri.ingredient?.name ?? ""} ${Number(ri.quantity).toFixed(2)}%`)
            .join(" ")
            .toLowerCase();
          const moneyText = `${Number(r.salePrice ?? 0).toFixed(2)} ${Number(r.costPerPound ?? 0).toFixed(2)}`;
          const blob = `${recipeName} ${desc} ${mixText} ${moneyText}`;
          return blob.includes(q);
        });

    const base = recipeFoodTypeFilter === "ALL"
      ? baseSearched
      : baseSearched.filter((r: any) => String(r.foodType || "Adult") === recipeFoodTypeFilter);

    const sorted = [...base].sort((a: any, b: any) => {
      const aUnit = String(a.chargeUnit ?? "lb");
      const bUnit = String(b.chargeUnit ?? "lb");
      const aAmount = Math.max(0.01, Number(a.amountPerUnit ?? 1));
      const bAmount = Math.max(0.01, Number(b.amountPerUnit ?? 1));
      const aChargePerLb = aUnit === "bag" ? Number(a.salePrice || 0) / aAmount : Number(a.salePrice || 0);
      const bChargePerLb = bUnit === "bag" ? Number(b.salePrice || 0) / bAmount : Number(b.salePrice || 0);
      const aMargin = Number(a.costPerPound) > 0 ? ((aChargePerLb - Number(a.costPerPound)) / Number(a.costPerPound)) * 100 : 0;
      const bMargin = Number(b.costPerPound) > 0 ? ((bChargePerLb - Number(b.costPerPound)) / Number(b.costPerPound)) * 100 : 0;

      let compare = 0;
      if (recipeSortBy === "name") compare = String(a.name ?? "").localeCompare(String(b.name ?? ""));
      else if (recipeSortBy === "foodType") compare = String(a.foodType ?? "Adult").localeCompare(String(b.foodType ?? "Adult"));
      else if (recipeSortBy === "unit") compare = aUnit.localeCompare(bUnit);
      else if (recipeSortBy === "margin") compare = aMargin - bMargin;
      else if (recipeSortBy === "costPerPound") compare = Number(a.costPerPound || 0) - Number(b.costPerPound || 0);
      else if (recipeSortBy === "salePrice") compare = Number(a.salePrice || 0) - Number(b.salePrice || 0);
      else compare = aAmount - bAmount;

      return recipeSortDirection === "asc" ? compare : -compare;
    });
    return sorted;
  }, [rows.recipes, recipeSearch, recipeFoodTypeFilter, recipeSortBy, recipeSortDirection]);

  const recipeOptionsSorted = useMemo(() => {
    return [...rows.recipes].sort((a: any, b: any) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  }, [rows.recipes]);

  const parseExpenseRowDetails = (row: any) => {
    const rawNotes = String(row?.notes || "");
    const [description = "", paymentFromNotes = ""] = rawNotes.split(" | ").map((part) => part.trim());
    const payment = String(row?.paymentMethod || "").trim() || paymentFromNotes;
    const rawReceipt = String(row?.receiptPath || row?.receiptUrl || "").trim();
    const receiptUrls = rawReceipt
      ? rawReceipt
          .split("|")
          .map((part) => part.trim())
          .filter(Boolean)
      : [];
    return {
      description,
      payment,
      receipt: receiptUrls[0] || "",
      receiptUrls
    };
  };

  const buildExpenseNotes = (description: string, payment: string) =>
    [String(description || "").trim(), String(payment || "").trim()].filter(Boolean).join(" | ");
  const resolveReceiptHref = (value: string) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const base = getPublicApiBase();
    const urlMatch = raw.match(/https?:\/\/\S+/i);
    const extracted = (urlMatch?.[0] || raw).trim();
    if (/^https?:\/\//i.test(extracted)) return extracted;
    if (extracted.startsWith("/uploads/")) return `${base}${extracted}`;
    if (extracted.startsWith("uploads/")) return `${base}/${extracted}`;
    return "";
  };
  const resolveInvoiceHref = (value: string) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("/")) return `${getPublicApiBase()}${raw}`;
    return "";
  };
  const isImageReceipt = (value: string) => /\.(png|jpe?g|webp|gif|bmp|svg)(\?.*)?$/i.test(value);
  const isPdfReceipt = (value: string) => /\.pdf(\?.*)?$/i.test(value);

  const ingredientOptionsSorted = useMemo(() => {
    return [...ingredients].sort((a: any, b: any) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
  }, [ingredients]);

  const filteredRecipeIngredientsByRatio = (recipe: any) => {
    return [...(recipe.ingredients || [])].sort((a: any, b: any) => Number(b.quantity) - Number(a.quantity));
  };

  const filteredRecipeLinesByRatio = (lines: Array<{ ingredientName: string; quantity: string }>) => {
    return [...lines].sort((a, b) => Number(b.quantity || 0) - Number(a.quantity || 0));
  };

  const filteredRecipesCountText = filteredRecipes.length === 1 ? "1 product" : `${filteredRecipes.length} products`;

  const ___ = filteredRecipeLinesByRatio;

  const recipeRows = filteredRecipes;

  const sortRecipeLinesForSave = (lines: Array<{ ingredientName: string; quantity: string }>) => ___(lines);

  const getSortedRecipeIngredients = (r: any) => filteredRecipeIngredientsByRatio(r);

  const getSortedLinesForEdit = (lines: Array<{ ingredientName: string; quantity: string }>) => ___(lines);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _noop = filteredRecipesCountText;

  const _filteredRecipes = recipeRows;

  const _recipeOptions = recipeOptionsSorted;
  const _ingredientOptions = ingredientOptionsSorted;

  // Keep compatibility with existing variable names used in JSX below.
  const recipesForTable = _filteredRecipes;
  const recipesForSelect = _recipeOptions;
  const ingredientsForSelect = _ingredientOptions;

  // --- end recipe organization helpers ---

  void _noop;

  function applyHubBootstrapBundle(bundle: any) {
    const calc = bundle?.calculatorTotals || {};
    const mergedOverview = {
      ...bundle.overview,
      customerCount: Number(calc.snapshot_customers_count ?? bundle.overview?.customerCount ?? 0),
      orderCount: Number(calc.snapshot_orders_total_count ?? bundle.overview?.orderCount ?? 0),
      expenseCount: Number(calc.snapshot_expense_rows_count ?? bundle.overview?.expenseCount ?? 0),
      recipeCount: Number(calc.snapshot_products_count ?? bundle.overview?.recipeCount ?? 0),
      ingredientCount: Number(
        calc.snapshot_ingredients_count ?? calc.snapshot_ingredient_inv_rows ?? bundle.overview?.ingredientCount ?? 0
      )
    };
    setOverview(mergedOverview);
    const pnlData = bundle.pnl;
    const rev = Number(pnlData.revenue ?? 0) + LIFETIME_PRIOR_SALES_TAX_INCL;
    const priorNet = LIFETIME_PRIOR_NET_SALES;
    const priorCogs = LIFETIME_PRIOR_COGS;
    const priorExp = LIFETIME_PRIOR_EXPENSES;
    const invPurch = Number((pnlData as any).expensesInventoryPurchases ?? 0);
    const opEx = Number(pnlData.expenses ?? 0) + LIFETIME_PRIOR_EXPENSES;
    setPnl({
      ...pnlData,
      revenue: rev,
      expenses: opEx,
      expensesTotal: opEx + invPurch,
      expensesInventoryPurchases: invPurch,
      cogs: Number(pnlData.cogs ?? 0) + priorCogs,
      grossProfit: Number(pnlData.grossProfit ?? 0) + (priorNet - priorCogs),
      netProfit: Number(pnlData.netProfit ?? 0) + (priorNet - priorCogs - priorExp)
    });
    setCustomers(bundle.customers);
    setIngredients(bundle.ingredients);
    setRecipes(bundle.recipes);
    setInventory(bundle.inventory);
    setOrders(bundle.orders);
    setExpenses(bundle.expenses);
    setInvoices(bundle.invoices);
    setPromoCodes(bundle.promoCodes);
    setKickbackPayments(Array.isArray(bundle.kickbackPayments) ? bundle.kickbackPayments : []);
    const mp = bundle.makingPlan;
    setMakingLines(mp.lines?.length ? mp.lines : [{ recipeId: "", amountLbs: "" }]);
    setMakingPlanNotes(mp.notes ?? "");
    setHubDashboard(hydrateDashboardAnalytics(bundle.dashboardAnalytics));
    hubBootstrapReadyRef.current = true;
  }

  async function loadAll() {
    setLoading(true);
    pushSheetWait("Loading hub…");
    setError("");
    try {
      try {
        await apiPost("/operations/invoices/sync-pending", {});
      } catch {
        // Best-effort: orders still load; Pending/Archive tabs also run sync when opened.
      }
      const q = new URLSearchParams({
        weeksBack: String(dashboardWeeksBack),
        reportFrom: reportRange.from,
        reportTo: reportRange.to
      });
      const bundle = await apiGet<any>(`/operations/hub-bootstrap?${q.toString()}`);
      applyHubBootstrapBundle(bundle);
      await loadFinanceData();
    } catch (e: any) {
      setError(e.message || "Failed to load data.");
    } finally {
      setLoading(false);
      popSheetWait();
    }
  }

  async function loadFinanceData() {
    const [expenseData, salesData, profitData, taxData] = await Promise.all([
      apiGetWithQuery("/reports/expenses/breakdown", expenseFilter),
      apiGetWithQuery("/reports/sales/summary", financeRange),
      apiGetWithQuery("/reports/profit/summary", financeRange),
      apiGetWithQuery("/reports/tax/nj", { ...financeRange, salesTaxRate: njTaxRate })
    ]);
    setExpenseBreakdown(expenseData);
    setSalesSummary(salesData);
    setProfitSummary(profitData);
    setTaxSummary(taxData);
  }

  async function refreshActiveTabData(tabOverride?: Tab) {
    const tab = tabOverride || activeTab;
    setLoading(true);
    pushSheetWait("Loading from sheet…");
    setError("");
    try {
      switch (tab) {
      case "Pending Orders": {
        try {
          await apiPost("/operations/invoices/sync-pending", {});
        } catch {
          // Non-fatal.
        }
        const [ordersData, invoicesData, recipesData] = await Promise.all([
          apiGet<any[]>("/operations/orders"),
          apiGet<any[]>("/operations/invoices"),
          apiGet<any[]>("/operations/recipes")
        ]);
        setOrders(ordersData);
        setInvoices(invoicesData);
        setRecipes(recipesData);
        return;
      }
      case "Archive Orders": {
        try {
          await apiPost("/operations/invoices/sync-archive", {});
        } catch {
          // Non-fatal.
        }
        const [ordersData, invoicesData, recipesData] = await Promise.all([
          apiGet<any[]>("/operations/orders"),
          apiGet<any[]>("/operations/invoices"),
          apiGet<any[]>("/operations/recipes")
        ]);
        setOrders(ordersData);
        setInvoices(invoicesData);
        setRecipes(recipesData);
        return;
      }
      case "Customers": {
        const [customersData, ordersData, invoicesData] = await Promise.all([
          apiGet<any[]>("/operations/customers"),
          apiGet<any[]>("/operations/orders"),
          apiGet<any[]>("/operations/invoices")
        ]);
        setCustomers(customersData);
        setOrders(ordersData);
        setInvoices(invoicesData);
        return;
      }
      case "Products": {
        const [recipesData, ingredientsData] = await Promise.all([apiGet<any[]>("/operations/recipes"), apiGet<any[]>("/operations/ingredients")]);
        setRecipes(recipesData);
        setIngredients(ingredientsData);
        return;
      }
      case "Inventory": {
        const [inventoryData, ingredientsData] = await Promise.all([apiGet<any[]>("/operations/inventory"), apiGet<any[]>("/operations/ingredients")]);
        setInventory(inventoryData);
        setIngredients(ingredientsData);
        return;
      }
      case "Submit Order": {
        const [customersData, recipesData, promoCodesData] = await Promise.all([
          apiGet<any[]>("/operations/customers"),
          apiGet<any[]>("/operations/recipes"),
          apiGet<any[]>("/operations/promo-codes")
        ]);
        setCustomers(customersData);
        setRecipes(recipesData);
        setPromoCodes(promoCodesData);
        return;
      }
      case "Making": {
        const [ordersData, recipesData, ingredientsData, makingPlanData, engineData] = await Promise.all([
          apiGet<any[]>("/operations/orders"),
          apiGet<any[]>("/operations/recipes"),
          apiGet<any[]>("/operations/ingredients"),
          apiGet<{ lines: Array<{ recipeId: string; amountLbs: string }>; notes: string }>("/operations/making-plan"),
          apiGet<any>("/operations/making-engine").catch(() => null)
        ]);
        setOrders(ordersData);
        setRecipes(recipesData);
        setIngredients(ingredientsData);
        setMakingLines(makingPlanData.lines?.length ? makingPlanData.lines : [{ recipeId: "", amountLbs: "" }]);
        setMakingPlanNotes(makingPlanData.notes ?? "");
        setMakingEngine(engineData?.ok ? engineData : null);
        return;
      }
      case "Invoices": {
        const [ordersData, invoicesData] = await Promise.all([apiGet<any[]>("/operations/orders"), apiGet<any[]>("/operations/invoices")]);
        setOrders(ordersData);
        setInvoices(invoicesData);
        return;
      }
      case "Coupons & Co-ops": {
        const [pc, cs, kb] = await Promise.all([
          apiGet<any[]>("/operations/promo-codes"),
          apiGet<
            {
              promoCodeId: string;
              code: string;
              label: string;
              payeeNotes: string | null;
              orderCount: number;
              kickbackOwed: number;
              revenueTaxIncl: number;
              kickbackPaid?: number;
              kickbackOutstanding?: number;
              lastKickbackPaidAt?: string | null;
            }[]
          >("/operations/promo-codes/coop-summary"),
          apiGet<any[]>("/operations/kickback-payments")
        ]);
        setPromoCodes(pc);
        setCoopSummary(cs);
        setKickbackPayments(kb);
        return;
      }
      case "Expenses":
      case "Sales":
      case "Profit":
      case "Tax": {
        const [ordersData, expensesData] = await Promise.all([apiGet<any[]>("/operations/orders"), apiGet<any[]>("/operations/expenses")]);
        setOrders(ordersData);
        setExpenses(expensesData);
        await loadFinanceData();
        return;
      }
      case "Dashboard": {
        const q = new URLSearchParams({
          weeksBack: String(dashboardWeeksBack),
          reportFrom: reportRange.from,
          reportTo: reportRange.to
        });
        const bundle = await apiGet<any>(`/operations/hub-bootstrap?${q.toString()}`);
        applyHubBootstrapBundle(bundle);
        return;
      }
      case "Calculator": {
        const data = await apiGet<any>("/reports/calculator");
        setCalculatorData(data);
        return;
      }
      case "Reports":
      default:
        await loadAll();
      }
    } catch (e: any) {
      setError(e.message || "Failed to refresh current tab.");
    } finally {
      setLoading(false);
      popSheetWait();
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (activeTab === "Dashboard") return;
    void refreshActiveTabData(activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!hubBootstrapReadyRef.current) return;
    if (hubDashboardParamsSkipFirst.current) {
      hubDashboardParamsSkipFirst.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const q = new URLSearchParams({
          weeksBack: String(dashboardWeeksBack),
          reportFrom: reportRange.from,
          reportTo: reportRange.to
        });
        const { dashboardAnalytics } = await apiGet<any>(`/operations/hub-dashboard?${q.toString()}`);
        if (!cancelled) setHubDashboard(hydrateDashboardAnalytics(dashboardAnalytics));
      } catch {
        /* keep existing aggregates */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dashboardWeeksBack, reportRange.from, reportRange.to]);

  useEffect(() => {
    if (!dashboardDrill) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDashboardDrill(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dashboardDrill]);

  /** Lock document scroll and block interaction with page behind overlays (with inert on <main>). */
  useEffect(() => {
    if (!anyModalOpen) return;
    const scrollY = window.scrollY;
    const html = document.documentElement;
    const prevBodyOverflow = document.body.style.overflow;
    const prevBodyPosition = document.body.style.position;
    const prevBodyTop = document.body.style.top;
    const prevBodyLeft = document.body.style.left;
    const prevBodyRight = document.body.style.right;
    const prevBodyWidth = document.body.style.width;
    const prevBodyPaddingRight = document.body.style.paddingRight;
    const prevHtmlOverflow = html.style.overflow;
    const scrollbarW = window.innerWidth - html.clientWidth;

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    if (scrollbarW > 0) document.body.style.paddingRight = `${scrollbarW}px`;
    html.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.position = prevBodyPosition;
      document.body.style.top = prevBodyTop;
      document.body.style.left = prevBodyLeft;
      document.body.style.right = prevBodyRight;
      document.body.style.width = prevBodyWidth;
      document.body.style.paddingRight = prevBodyPaddingRight;
      html.style.overflow = prevHtmlOverflow;
      window.scrollTo(0, scrollY);
    };
  }, [anyModalOpen]);

  useEffect(() => {
    try {
      const rawNotes = window.localStorage.getItem("jr-local-notes");
      const rawCalendar = window.localStorage.getItem("jr-local-calendar");
      if (rawNotes) setNotesList(JSON.parse(rawNotes));
      if (rawCalendar) setCalendarEvents(normalizeCalendarEvents(JSON.parse(rawCalendar)));
    } catch {
      // Keep app usable even if local storage has invalid JSON.
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("jr-local-notes", JSON.stringify(notesList));
  }, [notesList]);

  useEffect(() => {
    window.localStorage.setItem("jr-local-calendar", JSON.stringify(calendarEvents));
  }, [calendarEvents]);

  useEffect(() => {
    try {
      window.localStorage.setItem("jr-calendar-source-mode", calendarSourceMode);
    } catch {
      /* ignore */
    }
  }, [calendarSourceMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setWorkersCalInput((prev) => {
      if (prev.whenStart && prev.whenEnd) return prev;
      return {
        ...prev,
        whenStart: prev.whenStart || localDateTimeValue(new Date()),
        whenEnd: prev.whenEnd || localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000))
      };
    });
  }, []);

  useEffect(() => {
    if (activeTab !== "Calendar") return;
    if (calendarSourceMode === "local") {
      setWorkersIcsLoading(false);
      return;
    }
    let cancelled = false;
    setWorkersIcsLoading(true);
    setWorkersIcsError(null);
    void (async () => {
      try {
        if (jrWorkersCalendarAppsScriptConfigured()) {
          const { startISO, endISO } = workersCalendarAppsScriptRange(calendarMonth, calendarWeekAnchor);
          const list = await listJrWorkersCalendarEvents({ startISO, endISO });
          if (cancelled) return;
          const mapped = (Array.isArray(list) ? list : []).map(appsScriptEventToWorkersClientEvent);
          setWorkersIcs(mapped);
          setWorkersIcsMeta({
            pathTried: "Google Calendar (JR Workers Apps Script web app)",
            fileCount: mapped.length
          });
        } else {
          const data = await apiGet<{
            events: Omit<WorkersIcsClientEvent, "workersRemote">[];
            pathTried: string;
            fileCount: number;
            warning?: string;
          }>("/operations/calendar/workers-ics");
          if (cancelled) return;
          const raw = Array.isArray(data.events) ? data.events : [];
          setWorkersIcs(
            raw.map((e) => ({
              ...e,
              workersRemote: "ics" as const
            }))
          );
          setWorkersIcsMeta({
            pathTried: data.pathTried,
            fileCount: data.fileCount ?? 0,
            warning: data.warning
          });
        }
      } catch (e: any) {
        if (cancelled) return;
        setWorkersIcs([]);
        setWorkersIcsMeta(null);
        setWorkersIcsError(e?.message || "Failed to load JR Workers calendar");
      } finally {
        if (!cancelled) setWorkersIcsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, calendarSourceMode, workersIcsRefreshNonce, calendarMonth, calendarWeekAnchor]);

  useEffect(() => {
    if (!calendarPreviewItem) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCalendarPreviewItem(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [calendarPreviewItem]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const tick = () => {
      const now = Date.now();
      for (const ev of calendarEvents) {
        if (ev.done || !ev.reminderAt) continue;
        if (calendarReminderFiredRef.current.has(ev.id)) continue;
        const t = new Date(ev.reminderAt).getTime();
        if (!Number.isNaN(t) && t <= now) {
          calendarReminderFiredRef.current.add(ev.id);
          if (Notification.permission === "granted") {
            try {
              new Notification(ev.title || "Calendar reminder", { body: ev.note?.trim() ? ev.note : `Scheduled ${ev.date}${ev.time ? ` · ${ev.time}` : ""}` });
            } catch {
              // ignore
            }
          }
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 20_000);
    return () => window.clearInterval(id);
  }, [calendarEvents]);

  const resolveConfirm = useCallback((ok: boolean) => {
    setConfirmModal(null);
    const r = confirmResolverRef.current;
    confirmResolverRef.current = null;
    if (r) r(ok);
  }, []);

  const requestConfirm = useCallback((opts: { title: string; from?: unknown; to?: unknown }) => {
    return new Promise<boolean>((resolve) => {
      if (confirmResolverRef.current) confirmResolverRef.current(false);
      confirmResolverRef.current = resolve;
      setConfirmModal(opts);
    });
  }, []);

  useEffect(() => {
    if (!confirmModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") resolveConfirm(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmModal, resolveConfirm]);

  async function submit(
    handler: () => Promise<unknown>,
    confirmation?:
      | false
      | {
          title: string;
          from?: unknown;
          to?: unknown;
          /** Shown in the bottom queue + toast; locks this order’s card while queued/sending when orderId is set. */
          queueContext?: { orderId?: string; customerName?: string; customerPhone?: string };
        }
  ) {
    setError("");
    const confirmDetails: {
      title: string;
      from?: unknown;
      to?: unknown;
      queueContext?: { orderId?: string; customerName?: string; customerPhone?: string };
    } | null =
      confirmation === false
        ? null
        : confirmation === undefined
          ? { title: "Confirm change", from: "Current saved values", to: "Apply this update" }
          : confirmation;
    if (confirmDetails) {
      const ok = await requestConfirm({
        title: confirmDetails.title,
        from: confirmDetails.from,
        to: confirmDetails.to
      });
      if (!ok) return;
    }
    const pendingTitle = confirmDetails?.title || "Saving changes";
    try {
      await enqueueMutation(
        pendingTitle,
        async () => {
          await handler();
          await refreshActiveTabData();
        },
        { showSuccessToast: true, queueContext: confirmDetails?.queueContext }
      );
    } catch (e: any) {
      setError(e.message || "Action failed.");
    }
  }

  async function runReadOnly(handler: () => Promise<unknown>) {
    setError("");
    pushSheetWait("Loading…");
    try {
      await handler();
    } catch (e: any) {
      setError(e.message || "Action failed.");
    } finally {
      popSheetWait();
    }
  }

  function confirmChange(title: string, from: unknown, to: unknown) {
    return requestConfirm({ title, from, to });
  }

  function resetRecipeEditor() {
    setEditingRecipeId("");
    setRecipeForm({ name: "", description: "", foodType: "Adult", costPerPound: "", salePrice: "", chargeUnit: "lb", amountPerUnit: "1", isBundle: false });
    setRecipeLines(blankRecipeLines);
    setBundleLines(blankBundleLines);
  }

  function loadRecipeForEdit(recipe: any) {
    const linesRaw =
      (recipe.ingredients || []).map((item: any) => ({
        ingredientName: String(item.ingredient?.name ?? "").trim() || String(item.ingredientId ?? "").trim(),
        quantity: formatRecipeRatioForInput(item.quantity)
      })) || [];
    const bundleRaw =
      (recipe.bundleItems || []).map((item: any) => ({
        ingredientId: item.childRecipeId,
        quantity: formatRecipeRatioForInput(item.quantity)
      })) || [];
    const lines = getSortedLinesForEdit(linesRaw);
    setEditingRecipeId(recipe.id);
    setRecipeForm({
      name: recipe.name ?? "",
      description: recipe.description ?? "",
      foodType: recipe.foodType ?? "Adult",
      costPerPound: String(Number(recipe.costPerPound ?? 0)),
      salePrice: String(Number(recipe.salePrice ?? 0)),
      chargeUnit: String(recipe.chargeUnit ?? "lb"),
      amountPerUnit: String(Number(recipe.amountPerUnit ?? 1)),
      isBundle: Boolean(recipe.isBundle)
    });
    setRecipeLines(lines.length ? lines : blankRecipeLines);
    setBundleLines(bundleRaw.length ? bundleRaw : blankBundleLines);
  }

  function loadInvoiceFromOrder(orderId: string) {
    const order = orders.find((o: any) => o.id === orderId);
    if (!order) return;
    const orderDate = new Date(order.createdAt).toISOString().slice(0, 10);
    const phoneDigits = String(order.phone || order.customer?.phone || "").replace(/\D/g, "") || "nophone";
    const defaultInvoiceNumber = order.invoice?.invoiceNumber || `${orderDate}-${phoneDigits}`;
    setInvoiceBuilder((prev) => ({
      ...prev,
      orderId,
      invoiceNumber: prev.invoiceNumber || defaultInvoiceNumber,
      billToName: String(order.customerName || order.customer?.name || ""),
      billToEmail: String(order.email || order.customer?.email || ""),
      billToPhone: String(order.phone || order.customer?.phone || "")
    }));
    setInvoiceLines([{ description: `Order for ${String(order.customerName || order.customer?.name || "customer")}`, quantity: "1", unitPrice: Number(order.subtotal || 0).toFixed(2) }]);
  }

  function printInvoiceDocument() {
    const ink = (n: number) => (n >= 0 ? "green" : "crimson");
    const moneySpan = (n: number) => `<span style="color:${ink(n)}">$${fmtMoney(n)}</span>`;
    const lineRows = invoiceLines
      .map((line) => {
        const qty = Number(line.quantity || 0);
        const unitPrice = Number(line.unitPrice || 0);
        const lineTotal = qty * unitPrice;
        return `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb;">${line.description || "-"}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${qty.toFixed(
          2
        )}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${moneySpan(unitPrice)}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${moneySpan(
          lineTotal
        )}</td></tr>`;
      })
      .join("");
    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Invoice ${invoiceBuilder.invoiceNumber || ""}</title></head>
<body style="font-family:Inter,Arial,sans-serif;color:#1f2937;padding:24px;">
  <div style="max-width:820px;margin:auto;border:1px solid #d1d5db;border-radius:14px;overflow:hidden;">
    <div style="background:#d1fae5;color:#14532d;padding:20px 22px;border-bottom:2px solid #4ade80;">
      <h1 style="margin:0;font-size:28px;">INVOICE</h1>
      <div style="margin-top:6px;font-size:14px;opacity:.95;">Jersey Raw</div>
    </div>
    <div style="padding:20px 22px;">
      <div style="display:flex;justify-content:space-between;gap:20px;">
        <div><strong>Billed To</strong><div>${invoiceBuilder.billToName || ""}</div><div>${invoiceBuilder.billToEmail || ""}</div><div>${invoiceBuilder.billToPhone || ""}</div><div>${invoiceBuilder.billToAddress || ""}</div></div>
        <div style="text-align:right;"><div><strong>Invoice #:</strong> ${invoiceBuilder.invoiceNumber || ""}</div><div><strong>Date:</strong> ${invoiceBuilder.invoiceDate || ""}</div><div><strong>Due:</strong> ${invoiceBuilder.dueDate || ""}</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:18px;">
        <thead><tr style="background:#f3f4f6;"><th style="text-align:left;padding:9px;">Description</th><th style="text-align:right;padding:9px;">Qty</th><th style="text-align:right;padding:9px;">Unit Price</th><th style="text-align:right;padding:9px;">Amount</th></tr></thead>
        <tbody>${lineRows}</tbody>
      </table>
      <div style="display:flex;justify-content:flex-end;margin-top:16px;">
        <table style="min-width:290px;">
          <tr><td style="padding:5px 0;">Subtotal</td><td style="text-align:right;">${moneySpan(invoiceCalc.subtotal)}</td></tr>
          <tr><td style="padding:5px 0;">Discount</td><td style="text-align:right;"><span style="color:${ink(-invoiceCalc.discount)}">-$${fmtMoney(invoiceCalc.discount)}</span></td></tr>
          <tr><td style="padding:5px 0;">Tax (${Number(invoiceBuilder.taxRate || 0).toFixed(3)}%)</td><td style="text-align:right;">${moneySpan(invoiceCalc.tax)}</td></tr>
          <tr><td style="padding-top:9px;font-weight:700;font-size:18px;">Total</td><td style="text-align:right;padding-top:9px;font-weight:700;font-size:18px;">${moneySpan(invoiceCalc.total)}</td></tr>
        </table>
      </div>
      <div style="margin-top:16px;font-size:13px;color:#4b5563;">${invoiceBuilder.notes || ""}</div>
    </div>
  </div>
</body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  }

  const orderRecipeLabel = (o: any) => {
    const lines = parseOrderItemLines(o);
    if (lines.length > 0) {
      return lines
        .map((ln) => `${ln.recipeName} x${Number(ln.quantityLbs || 0).toFixed(0)}`)
        .join(", ");
    }
    return String(o.productSummary || o.recipe?.name || recipes.find((r: any) => r.id === o.recipeId)?.name || "—");
  };
  const orderCustomerName = (o: any) => String(o.customerName || o.customer?.name || "").trim();
  const orderCustomerPhone = (o: any) => String(o.phone || o.customer?.phone || "").trim();
  const orderCustomerEmail = (o: any) => String(o.email || o.customer?.email || "").trim();
  const pendingOrderQueueContext = (o: any) => ({
    orderId: String(o.id),
    customerName: orderCustomerName(o) || "—",
    customerPhone: orderCustomerPhone(o) || "—"
  });

  const pendingOrdersForJrPickups = useMemo(() => {
    const rawQ = jrWorkerPickupsSearch.trim();
    const q = rawQ.toLowerCase();
    const qDigits = phoneDigitsOnly(rawQ);
    if (!q && !(qDigits.length >= 3)) return pendingOrders;
    return pendingOrders.filter((o: any) => {
      const name = orderCustomerName(o).toLowerCase();
      const phone = orderCustomerPhone(o);
      const email = orderCustomerEmail(o).toLowerCase();
      const id = String(o.id || "").toLowerCase();
      const notes = String(o.notes || "").toLowerCase();
      const recipe = orderRecipeLabel(o).toLowerCase();
      const inv = String(o.invoice?.invoiceNumber || "").toLowerCase();
      const status = String(o.status || "").toLowerCase();
      const pay = String(o.paymentStatus || "").toLowerCase();
      const phoneDig = phoneDigitsOnly(phone);
      const digitHit = qDigits.length >= 3 && phoneDig.includes(qDigits);
      if (!q) return digitHit;
      return (
        digitHit ||
        name.includes(q) ||
        phone.toLowerCase().includes(q) ||
        email.includes(q) ||
        id.includes(q) ||
        notes.includes(q) ||
        recipe.includes(q) ||
        inv.includes(q) ||
        status.includes(q) ||
        pay.includes(q)
      );
    });
  }, [pendingOrders, jrWorkerPickupsSearch, recipes]);

  const dirtyJrWorkerPickups = useMemo(() => {
    return pendingOrdersForJrPickups.filter(
      (o: any) => pendingOrderDraftDiff(o, orderNoteById, pendingPaymentMethodByOrder).dirty
    );
  }, [pendingOrdersForJrPickups, orderNoteById, pendingPaymentMethodByOrder]);

  const orderItemList = (o: any): Array<{ item: string; qty: number; unit: string; amountPerLb: number; lineTotal: number }> => {
    try {
      const raw = JSON.parse(String(o.orderItemsJson || "[]"));
      if (!Array.isArray(raw)) return [];
      return raw
        .map((x: any) => {
          const item = String(x.productName || x.recipeName || "").trim();
          const qty = Number(x.quantity || x.quantityLbs || 0);
          const unit = String(x.quantityUnit || (x.quantityLbs ? "lb" : "unit")).toLowerCase();
          const lineTotal = Number(x.lineSubtotal || 0);
          const amountPerLb = qty > 0 ? lineTotal / qty : Number(x.unitPrice || 0);
          return { item, qty, unit, amountPerLb, lineTotal };
        })
        .filter((r) => r.item && r.qty > 0);
    } catch {
      return [];
    }
  };

  const dashboardDrillModalEl = (() => {
    if (!dashboardDrill) return null;
    const drill = dashboardDrill;
    const p0 = dashboardPeriodBounds.rangeStart;
    const p1 = dashboardPeriodBounds.rangeEnd;
    const periodStr = `Dashboard chart range: last ${dashboardWeeksBack} weeks (${p0.toLocaleDateString()} – ${p1.toLocaleDateString()}).`;

    const th: Record<string, string | number> = { border: "1px solid #cbd5e1", padding: 6, textAlign: "left" };
    const td: Record<string, string | number> = { border: "1px solid #e2e8f0", padding: 6 };
    const tdn: Record<string, string | number> = { border: "1px solid #e2e8f0", padding: 6, textAlign: "right" };
    const thR: Record<string, string | number> = { ...th, textAlign: "right" };

    const ordersInPeriod = orders.filter((o: any) => {
      const d = new Date(o.createdAt);
      return d >= p0 && d <= p1;
    });
    const expensesInPeriod = expenses.filter((e: any) => {
      const d = new Date(e.expenseDate || e.createdAt);
      return d >= p0 && d <= p1;
    });
    const nonCancelled = (list: any[]) => list.filter((o: any) => o.status !== "CANCELLED");

    const aggLbs = (list: any[]) => {
      const m = new Map<string, { recipe: string; orderCount: number; lbs: number; net: number; profit: number; salesIncl: number }>();
      for (const o of list) {
        if (o.status === "CANCELLED") continue;
        const om = orderMetrics(o);
        const name = orderRecipeLabel(o);
        const c = m.get(name) || { recipe: name, orderCount: 0, lbs: 0, net: 0, profit: 0, salesIncl: 0 };
        c.orderCount += 1;
        c.lbs += om.lbs;
        c.net += om.netRevenue;
        c.profit += om.profitTotal;
        c.salesIncl += om.subtotal;
        m.set(name, c);
      }
      return [...m.values()].sort((a, b) => b.lbs - a.lbs);
    };

    const tblOrdersMoney = (list: any[]) => (
      <div style={{ overflowX: "auto", maxHeight: "min(58vh, 520px)", overflowY: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#f1f5f9" }}>
              <th style={th as CSSProperties}>When</th>
              <th style={th as CSSProperties}>Customer</th>
              <th style={th as CSSProperties}>Status</th>
              <th style={th as CSSProperties}>Recipe / product</th>
              <th style={thR as CSSProperties}>Lbs</th>
              <th style={thR as CSSProperties}>Incl. tax</th>
              <th style={thR as CSSProperties}>Net</th>
              <th style={thR as CSSProperties}>Tax</th>
              <th style={thR as CSSProperties}>COGS</th>
              <th style={thR as CSSProperties}>Profit</th>
              <th style={th as CSSProperties}>Invoice #</th>
            </tr>
          </thead>
          <tbody>
            {[...list]
              .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map((o: any) => {
                const m = orderMetrics(o);
  return (
                  <tr key={o.id}>
                    <td style={td as CSSProperties}>{new Date(o.createdAt).toLocaleString()}</td>
                    <td style={td as CSSProperties}>{o.customer?.name || "—"}</td>
                    <td style={td as CSSProperties}>{o.status}</td>
                    <td style={td as CSSProperties}>{orderRecipeLabel(o)}</td>
                    <td style={tdn as CSSProperties}>{m.lbs.toFixed(2)}</td>
                    <td style={tdn as CSSProperties}>
                      <SignedMoney value={m.subtotal} />
                    </td>
                    <td style={tdn as CSSProperties}>
                      <SignedMoney value={m.netRevenue} />
                    </td>
                    <td style={tdn as CSSProperties}>
                      <SignedMoney value={m.salesTax} />
                    </td>
                    <td style={tdn as CSSProperties}>
                      <SignedMoney value={m.cogs} />
                    </td>
                    <td style={tdn as CSSProperties}>
                      <SignedMoney value={m.profitTotal} />
                    </td>
                    <td style={td as CSSProperties}>{o.invoice?.invoiceNumber || "—"}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    );

    const tblExpenses = (list: any[]) => (
      <div style={{ overflowX: "auto", maxHeight: "min(50vh, 440px)", overflowY: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#fef2f2" }}>
              <th style={th as CSSProperties}>When</th>
              <th style={th as CSSProperties}>Vendor</th>
              <th style={th as CSSProperties}>Category</th>
              <th style={thR as CSSProperties}>Amount</th>
              <th style={th as CSSProperties}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {[...list]
              .sort((a: any, b: any) => new Date(b.expenseDate || b.createdAt).getTime() - new Date(a.expenseDate || a.createdAt).getTime())
              .map((e: any) => (
                <tr key={e.id}>
                  <td style={td as CSSProperties}>{new Date(e.expenseDate || e.createdAt).toLocaleString()}</td>
                  <td style={td as CSSProperties}>{e.vendor}</td>
                  <td style={td as CSSProperties}>{e.category}</td>
                  <td style={tdn as CSSProperties}>
                    <SignedMoney value={e.amount} />
                  </td>
                  <td style={{ ...(td as CSSProperties), fontSize: 11 }}>{e.notes ? String(e.notes).slice(0, 160) : "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    );

    const customerRollupForProductMix = (orderList: any[]) => {
      const m = new Map<string, { lbs: number; profit: number }>();
      for (const o of orderList) {
        if (o.status === "CANCELLED") continue;
        const om = orderMetrics(o);
        const key =
          String(
            o.customerId ||
              o.customer?.id ||
              o.customer?.phone ||
              o.customer?.email ||
              o.customer?.name ||
              `${o.customerName || ""}|${o.phone || ""}|${o.email || ""}`
          ).trim() || String(o.id);
        const cur = m.get(key) || { lbs: 0, profit: 0 };
        cur.lbs += om.lbs;
        cur.profit += om.profitTotal;
        m.set(key, cur);
      }
      const rows = [...m.values()].filter((r) => r.lbs > 0);
      const n = rows.length;
      const totalProfit = rows.reduce((s, r) => s + r.profit, 0);
      const avgProfitPerCustomer = n > 0 ? totalProfit / n : 0;
      const avgOfCustomerProfitPerLb = n > 0 ? rows.reduce((s, r) => s + r.profit / r.lbs, 0) / n : 0;
      return { customerCount: n, totalProfit, avgProfitPerCustomer, avgOfCustomerProfitPerLb };
    };

    const tblLbsRecipe = (
      rows: { recipe: string; orderCount: number; lbs: number; net: number; profit: number; salesIncl: number }[],
      rollup?: { customerCount: number; totalProfit: number; avgProfitPerCustomer: number; avgOfCustomerProfitPerLb: number }
    ) => (
      <div style={{ overflowX: "auto", maxHeight: "min(50vh, 480px)", overflowY: "auto" }}>
        <div style={{ padding: "10px 10px 0", fontSize: 12, color: "#334155", lineHeight: 1.35 }}>
          <div style={{ fontWeight: 800, color: "#0f172a" }}>How this is calculated</div>
          <ul style={{ margin: "6px 0 10px", paddingLeft: 18 }}>
            <li>
              <strong>Rows</strong>: grouped by the order’s “Recipe / product” label. Only orders where <code>status !== "CANCELLED"</code> are included.
            </li>
            <li>
              <strong>Orders</strong>: count of orders in the group.
            </li>
            <li>
              <strong>Lbs (units)</strong>: sum of per-order pounds from the saved order lines when available (bags × lbs per bag when applicable), otherwise it falls back to
              the order’s <code>quantityLbs</code>.
            </li>
            <li>
              <strong>Sales (incl.)</strong>: sum of the order total including NJ sales tax.
            </li>
            <li>
              <strong>Net</strong>: estimated pre-tax revenue (Sales − estimated tax).
            </li>
            <li>
              <strong>Profit</strong>: Net − food cost (COGS). If an order has a stored <code>profit</code> field, that value is used; otherwise profit is derived from COGS when
              available. <strong>Profit/lb</strong> for that order is <code>profit ÷ lbs</code> when <code>profit</code> is present (so it stays consistent); only if profit is
              missing but <code>profitPerLb</code> is set does the hub use the per-lb column alone.
            </li>
            <li>
              <strong>Profit/lb (this column)</strong>: for each recipe row, <em>sum of profit ÷ sum of lbs</em> for that recipe — dollars per pound <strong>for that product
              mix</strong>, not averaged “per person”.
            </li>
            <li>
              <strong>Per-customer mental model</strong>: for each customer, total lbs × (their total profit ÷ their total lbs) = their total profit. Adding those customer
              profits = overall profit. Dividing overall profit by the number of customers (with lbs &gt; 0) gives <strong>average profit per customer</strong> (see the box
              below). That is a different number than “total profit ÷ total lbs”.
            </li>
          </ul>
        </div>
        {rollup && rollup.customerCount > 0 ? (
          <div
            style={{
              margin: "0 10px 10px",
              padding: 10,
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5
            }}
          >
            <div style={{ fontWeight: 800, color: "#0f172a" }}>Customer rollup (same scope as this table)</div>
            <div style={{ marginTop: 6 }}>
              Customers with lbs &gt; 0: <strong>{rollup.customerCount}</strong>
            </div>
            <div>
              Σ (each customer’s lbs × their blended $/lb) = total profit: <SignedMoney value={rollup.totalProfit} />
            </div>
            <div>
              Average profit per customer (total profit ÷ customers): <SignedMoney value={rollup.avgProfitPerCustomer} />
            </div>
            <div>
              Simple average of each customer’s profit/lb: <SignedMoney value={rollup.avgOfCustomerProfitPerLb} />
            </div>
          </div>
        ) : null}
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#ecfdf5" }}>
              <th style={th as CSSProperties}>Recipe / product</th>
              <th style={{ ...(th as CSSProperties), textAlign: "center" }}>Orders</th>
              <th style={thR as CSSProperties}>Lbs (units)</th>
              <th style={thR as CSSProperties}>Sales (incl.)</th>
              <th style={thR as CSSProperties}>Net</th>
              <th style={thR as CSSProperties}>Profit</th>
              <th style={thR as CSSProperties}>Profit/lb</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.recipe}>
                <td style={td as CSSProperties}>{r.recipe}</td>
                <td style={{ ...(td as CSSProperties), textAlign: "center" }}>{r.orderCount}</td>
                <td style={tdn as CSSProperties}>{r.lbs.toFixed(2)}</td>
                <td style={tdn as CSSProperties}>
                  <SignedMoney value={r.salesIncl} />
                </td>
                <td style={tdn as CSSProperties}>
                  <SignedMoney value={r.net} />
                </td>
                <td style={tdn as CSSProperties}>
                  <SignedMoney value={r.profit} />
                </td>
                <td style={tdn as CSSProperties}>
                  <SignedMoney value={r.lbs > 0 ? r.profit / r.lbs : 0} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

    let title = "Details";
    let subtitle: string | null = null;
    let body: ReactNode = null;

    const profitSum = (list: any[]) => nonCancelled(list).reduce((s, o) => s + orderMetrics(o).profitTotal, 0);
    const expSum = (list: any[]) => list.reduce((s, e) => s + Number(e.amount || 0), 0);
    const expSumOperating = (list: any[]) =>
      list.reduce((s, e) => s + (isPnlInventoryPurchaseExpenseCategory(e.category) ? 0 : Number(e.amount || 0)), 0);

    switch (drill.type) {
      case "customers":
        title = "All customers";
        subtitle = `${customers.length} customer records (name, email, phone).`;
        body = (
          <div style={{ overflowX: "auto", maxHeight: "min(60vh, 560px)", overflowY: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f1f5f9" }}>
                  <th style={th as CSSProperties}>Name</th>
                  <th style={th as CSSProperties}>Email</th>
                  <th style={th as CSSProperties}>Phone</th>
                </tr>
              </thead>
              <tbody>
                {[...customers]
                  .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
                  .map((c: any) => (
                    <tr key={c.id}>
                      <td style={td as CSSProperties}>{c.name}</td>
                      <td style={td as CSSProperties}>{c.email || "—"}</td>
                      <td style={td as CSSProperties}>{c.phone || "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        );
        break;
      case "customers-activity": {
        title = "Customers (by active order count)";
        subtitle = "Non-cancelled orders only — lifetime.";
        const counts = new Map<string, number>();
        for (const o of orders) {
          if (o.status === "CANCELLED") continue;
          counts.set(o.customerId, (counts.get(o.customerId) || 0) + 1);
        }
        const rows = [...customers]
          .map((c: any) => ({ c, n: counts.get(c.id) || 0 }))
          .sort((a, b) => b.n - a.n || String(a.c.name).localeCompare(String(b.c.name)));
        body = (
          <div style={{ overflowX: "auto", maxHeight: "min(60vh, 560px)", overflowY: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f1f5f9" }}>
                  <th style={th as CSSProperties}>Name</th>
                  <th style={th as CSSProperties}>Email</th>
                  <th style={th as CSSProperties}>Phone</th>
                  <th style={thR as CSSProperties}>Active orders</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, n }) => (
                  <tr key={c.id}>
                    <td style={td as CSSProperties}>{c.name}</td>
                    <td style={td as CSSProperties}>{c.email || "—"}</td>
                    <td style={td as CSSProperties}>{c.phone || "—"}</td>
                    <td style={tdn as CSSProperties}>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        break;
      }
      case "orders-all":
        title = "All orders";
        subtitle = `${orders.length} rows — every status.`;
        body = tblOrdersMoney(orders);
        break;
      case "expenses-all":
        title = "All expenses";
        subtitle = `${expenses.length} expense entries (all dates).`;
        body = tblExpenses(expenses);
        break;
      case "expenses-period":
        title = `Expenses — ${periodStr}`;
        subtitle = `${expensesInPeriod.length} entries in range.`;
        body = tblExpenses(expensesInPeriod);
        break;
      case "recipes-all":
        title = "All recipes";
        subtitle = `${recipes.length} products / mixes.`;
        body = (
          <div style={{ overflowX: "auto", maxHeight: "min(60vh, 520px)", overflowY: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#ecfdf5" }}>
                  <th style={th as CSSProperties}>Name</th>
                  <th style={th as CSSProperties}>Type</th>
                  <th style={th as CSSProperties}>Unit</th>
                  <th style={thR as CSSProperties}>Cost/lb</th>
                  <th style={thR as CSSProperties}>Sale</th>
                </tr>
              </thead>
              <tbody>
                {[...recipes]
                  .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
                  .map((r: any) => (
                    <tr key={r.id}>
                      <td style={td as CSSProperties}>{r.name}</td>
                      <td style={td as CSSProperties}>{r.foodType || "—"}</td>
                      <td style={td as CSSProperties}>{r.chargeUnit === "bag" ? `bag (${r.amountPerUnit} lb)` : "lb"}</td>
                      <td style={tdn as CSSProperties}>
                        <SignedMoney value={r.costPerPound} />
                      </td>
                      <td style={tdn as CSSProperties}>
                        <SignedMoney value={r.salePrice} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        );
        break;
      case "ingredients-all":
        title = "All ingredients";
        subtitle = "On-hand quantity and cost (as stored).";
        body = (
          <div style={{ overflowX: "auto", maxHeight: "min(60vh, 560px)", overflowY: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#fff7ed" }}>
                  <th style={th as CSSProperties}>Name</th>
                  <th style={th as CSSProperties}>Category</th>
                  <th style={th as CSSProperties}>Unit</th>
                  <th style={thR as CSSProperties}>Qty on hand</th>
                  <th style={thR as CSSProperties}>Total cost</th>
                  <th style={thR as CSSProperties}>Charge/lb</th>
                </tr>
              </thead>
              <tbody>
                {[...ingredients]
                  .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
                  .map((i: any) => (
                    <tr key={i.id}>
                      <td style={td as CSSProperties}>{i.name}</td>
                      <td style={td as CSSProperties}>{i.category || "—"}</td>
                      <td style={td as CSSProperties}>{i.unit || "lb"}</td>
                      <td style={tdn as CSSProperties}>{Number(i.quantityOnHand || 0).toFixed(2)}</td>
                      <td style={tdn as CSSProperties}>
                        <SignedMoney value={i.totalCost} />
                      </td>
                      <td style={tdn as CSSProperties}>
                        <SignedMoney value={i.chargePerPound} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        );
        break;
      case "inventory-lots":
        title = "Inventory lots";
        subtitle = `${inventory.length} received lots.`;
        body = (
          <div style={{ overflowX: "auto", maxHeight: "min(60vh, 520px)", overflowY: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f1f5f9" }}>
                  <th style={th as CSSProperties}>Ingredient</th>
                  <th style={thR as CSSProperties}>Qty lbs</th>
                  <th style={thR as CSSProperties}>Unit cost</th>
                  <th style={th as CSSProperties}>Received</th>
                </tr>
              </thead>
              <tbody>
                {[...inventory]
                  .sort((a: any, b: any) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
                  .map((lot: any) => (
                    <tr key={lot.id}>
                      <td style={td as CSSProperties}>{lot.ingredient}</td>
                      <td style={tdn as CSSProperties}>{Number(lot.quantityLbs || 0).toFixed(2)}</td>
                      <td style={tdn as CSSProperties}>
                        <SignedMoney value={lot.unitCost} />
                      </td>
                      <td style={td as CSSProperties}>{new Date(lot.receivedAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        );
        break;
      case "invoices-all":
        title = "All invoice records";
        subtitle = `${invoices.length} invoices.`;
        body = (
          <div style={{ overflowX: "auto", maxHeight: "min(60vh, 520px)", overflowY: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f1f5f9" }}>
                  <th style={th as CSSProperties}>#</th>
                  <th style={thR as CSSProperties}>Amount</th>
                  <th style={th as CSSProperties}>Payment</th>
                  <th style={th as CSSProperties}>Order customer</th>
                </tr>
              </thead>
              <tbody>
                {[...invoices]
                  .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                  .map((inv: any) => (
                    <tr key={inv.id}>
                      <td style={td as CSSProperties}>{inv.invoiceNumber}</td>
                      <td style={tdn as CSSProperties}>
                        <SignedMoney value={inv.amount} />
                      </td>
                      <td style={td as CSSProperties}>{inv.payment?.status || "UNPAID"}</td>
                      <td style={td as CSSProperties}>{inv.order?.customer?.name || "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        );
        break;
      case "invoices-paid": {
        title = "Paid invoices";
        const paid = invoices.filter((inv: any) => String(inv?.payment?.status || "").toUpperCase() === "PAID");
        subtitle = `${paid.length} of ${invoices.length} invoice records.`;
        body = (
          <div style={{ overflowX: "auto", maxHeight: "min(60vh, 520px)", overflowY: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#ecfdf5" }}>
                  <th style={th as CSSProperties}>#</th>
                  <th style={thR as CSSProperties}>Amount</th>
                  <th style={th as CSSProperties}>Customer</th>
                </tr>
              </thead>
              <tbody>
                {paid.map((inv: any) => (
                  <tr key={inv.id}>
                    <td style={td as CSSProperties}>{inv.invoiceNumber}</td>
                    <td style={tdn as CSSProperties}>
                      <SignedMoney value={inv.amount} />
                    </td>
                    <td style={td as CSSProperties}>{inv.order?.customer?.name || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        break;
      }
      case "orders-money-period":
        title = `Order financials — ${periodStr}`;
        subtitle = "Non-cancelled orders only (matches dashboard sales/profit totals).";
        body = tblOrdersMoney(nonCancelled(ordersInPeriod));
        break;
      case "orders-money-lifetime":
        title = "Order financials — lifetime";
        subtitle = "Non-cancelled orders only.";
        body = tblOrdersMoney(nonCancelled(orders));
        break;
      case "orders-active-period":
        title = `Active orders — ${periodStr}`;
        subtitle = "Not cancelled.";
        body = tblOrdersMoney(nonCancelled(ordersInPeriod));
        break;
      case "orders-active-lifetime":
        title = "Active orders — lifetime";
        body = tblOrdersMoney(nonCancelled(orders));
        break;
      case "orders-cancelled-period":
        title = `Cancelled orders — ${periodStr}`;
        body = tblOrdersMoney(ordersInPeriod.filter((o: any) => o.status === "CANCELLED"));
        break;
      case "orders-cancelled-lifetime":
        title = "Cancelled orders — lifetime";
        body = tblOrdersMoney(orders.filter((o: any) => o.status === "CANCELLED"));
        break;
      case "orders-pending-lifetime":
        title = "Pending pipeline — lifetime (NEW / CONFIRMED)";
        body = tblOrdersMoney(orders.filter((o: any) => o.status === "NEW" || o.status === "CONFIRMED"));
        break;
      case "orders-fulfilled-lifetime":
        title = "Fulfilled orders — lifetime";
        body = tblOrdersMoney(orders.filter((o: any) => o.status === "FULFILLED"));
        break;
      case "orders-paid-lifetime":
        title = "Orders marked paid — lifetime";
        body = tblOrdersMoney(
          orders.filter((o: any) => Boolean(o?.paidAt) || String(o?.paymentStatus || "").toUpperCase() === "PAID")
        );
        break;
      case "orders-with-invoice-lifetime":
        title = "Orders with an invoice — lifetime";
        body = tblOrdersMoney(orders.filter((o: any) => o.invoice));
        break;
      case "lbs-recipe-period":
        title = `Lbs / product mix — ${periodStr}`;
        subtitle = "Totals by recipe (non-cancelled orders).";
        body = tblLbsRecipe(aggLbs(ordersInPeriod), customerRollupForProductMix(ordersInPeriod));
        break;
      case "lbs-recipe-lifetime":
        title = "Lbs / product mix — lifetime";
        body = tblLbsRecipe(aggLbs(orders), customerRollupForProductMix(orders));
        break;
      case "net-after-period": {
        title = `Net profit — ${periodStr}`;
        const ps = profitSum(ordersInPeriod);
        const es = expSumOperating(expensesInPeriod);
        subtitle = `Order gross profit (net sales − food cost) ${fmtMoney(ps)} − operating expenses in range (excl. inventory purchase categories) ${fmtMoney(es)} = ${fmtMoney(ps - es)}`;
        body = (
          <>
            <h4 style={{ marginTop: 0 }}>Contributing orders</h4>
            {tblOrdersMoney(nonCancelled(ordersInPeriod))}
            <h4>Contributing expenses</h4>
            {tblExpenses(expensesInPeriod)}
          </>
        );
        break;
      }
      case "net-after-lifetime": {
        title = "Net profit — lifetime";
        const netH = Number(dashboardLifetimeStats.netSales ?? 0);
        const expH = Number(dashboardLifetimeStats.expenseTotal ?? 0);
        subtitle = `Headline matches the dashboard card: net sales (pre-tax, excluding sales tax) ${fmtMoney(netH)} − all expenses ${fmtMoney(expH)} = ${fmtMoney(netH - expH)}. “Gross profit” above is still order net sales − food cost (COGS), before expenses.`;
        body = (
          <>
            <h4 style={{ marginTop: 0 }}>All non-cancelled orders</h4>
            {tblOrdersMoney(nonCancelled(orders))}
            <h4>All expenses</h4>
            {tblExpenses(expenses)}
          </>
        );
        break;
      }
      case "pnl-books":
        title = "Books P&L (report)";
        subtitle =
          "From /reports/pnl. COGS on each order uses product cost/lb (ingredient mix). Expenses in ingredient categories (Meats, Organs, Dairy, etc.) are inventory purchases — they are not subtracted again as operating expense, or food cost would be double-counted. Net profit = net sales − COGS − operating expenses (other categories only).";
        body = (
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              Revenue (tax incl.): <SignedMoney value={pnl.revenue} />
            </li>
            <li>
              COGS (cost of goods sold — food cost): <SignedMoney value={Number(pnl.cogs ?? 0)} />
            </li>
            <li>
              Gross profit (net sales − COGS): <SignedMoney value={Number(pnl.grossProfit ?? 0)} />
            </li>
            <li>
              Operating expenses (excludes inventory purchase categories): <SignedMoney value={pnl.expenses} />
            </li>
            {Number((pnl as any).expensesInventoryPurchases ?? 0) > 0 ? (
              <li style={{ fontSize: 13, color: "#475569" }}>
                Inventory / raw-material expenses excluded from operating (already in COGS via orders):{" "}
                <SignedMoney value={Number((pnl as any).expensesInventoryPurchases ?? 0)} />
              </li>
            ) : null}
            <li>
              Net profit: <SignedMoney value={pnl.netProfit} />
            </li>
          </ul>
        );
        break;
      case "week": {
        const ws = new Date(drill.startIso);
        const we = new Date(drill.endIso);
        title = `Week ${drill.label}`;
        subtitle = `${ws.toLocaleDateString()} – ${we.toLocaleDateString()}`;
        const wOrders = orders.filter((o: any) => {
          const d = new Date(o.createdAt);
          return d >= ws && d <= we;
        });
        const wExp = expenses.filter((e: any) => {
          const d = new Date(e.expenseDate || e.createdAt);
          return d >= ws && d <= we;
        });
        body = (
          <>
            <h4 style={{ marginTop: 0 }}>Orders ({wOrders.length})</h4>
            {tblOrdersMoney(wOrders)}
            <h4>Expenses ({wExp.length})</h4>
            {tblExpenses(wExp)}
            <h4>Lbs by recipe (non-cancelled)</h4>
            {tblLbsRecipe(aggLbs(wOrders), customerRollupForProductMix(wOrders))}
          </>
        );
        break;
      }
      default:
        body = <p>Unknown drill type.</p>;
    }

    return (
      <div
        role="dialog"
        aria-modal
        aria-labelledby="dash-drill-title"
        onClick={() => setDashboardDrill(null)}
        onWheel={preventModalBackdropWheel}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9998,
          background: "rgba(15, 46, 32, 0.5)",
          backdropFilter: "blur(3px)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "32px 16px",
          overflowY: "auto",
          overscrollBehavior: "contain",
          touchAction: "pan-y"
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            maxWidth: 960,
            maxHeight: "min(92vh, 900px)",
            display: "flex",
            flexDirection: "column",
            borderRadius: 16,
            overflow: "hidden",
            boxShadow: "0 24px 48px rgba(31, 77, 55, 0.35)",
            border: "1px solid #9ec1ac",
            background: "#fff",
            touchAction: "auto",
            overscrollBehavior: "contain"
          }}
        >
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
              padding: "16px 18px",
              background: "linear-gradient(135deg, #bbf7d0, #d1fae5)",
              color: "#14532d",
              borderBottom: "1px solid #6ee7b7"
            }}
          >
            <div>
              <h2 id="dash-drill-title" style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>
                {title}
              </h2>
              {subtitle ? <p style={{ margin: "8px 0 0", fontSize: 13, color: "#166534" }}>{subtitle}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => setDashboardDrill(null)}
              style={{
                flexShrink: 0,
                padding: "8px 14px",
                borderRadius: 10,
                border: "1px solid #166534",
                background: "#f0fdf4",
                color: "#14532d",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              Close
            </button>
          </div>
          <div style={{ padding: 16, overflowY: "auto", flex: 1, background: "#fafdfb" }}>{body}</div>
        </div>
      </div>
    );
  })();

  return (
    <>
    <main
      {...(anyModalOpen ? { inert: true } : {})}
      style={{ maxWidth: 1320, margin: "20px auto", padding: "0 16px 28px" }}
    >
      <div
        style={{
          background: "linear-gradient(135deg, #ecfdf5, #d1fae5)",
          borderRadius: 16,
          padding: "16px 18px",
          color: "#0f172a",
          marginBottom: 12,
          border: "1px solid #86efac",
          boxShadow: "0 10px 24px rgba(31, 77, 55, 0.12)"
        }}
      >
        <h1 style={{ margin: "0 0 6px", color: "#14532d" }}>Management Control Hub</h1>
        <p style={{ margin: "0 0 4px", color: "#166534" }}>Offline-first local operations for taxes, inventory, recipes, and invoicing.</p>
        <p style={{ margin: 0, color: "#1f4d37" }}>
          API base:{" "}
          <code style={{ background: "#bbf7d0", color: "#14532d", border: "1px solid #4ade80", padding: "2px 8px", borderRadius: 6 }}>
            {getPublicApiBase()}
          </code>
        </p>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 16,
          position: "sticky",
          top: 8,
          zIndex: 5,
          background: "rgba(238,243,238,0.92)",
          padding: 10,
          borderRadius: 12,
          border: "1px solid #cfe0d4",
          backdropFilter: "blur(3px)"
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: activeTab === tab ? "2px solid #166534" : "1px solid #9ec1ac",
              background: activeTab === tab ? "#bbf7d0" : "#f7fbf8",
              color: activeTab === tab ? "#14532d" : "#1f4d37",
              fontWeight: activeTab === tab ? 700 : 600
            }}
          >
            {tab}
          </button>
        ))}
        <button
          type="button"
          className="hub-btn-primary"
          onClick={() => void refreshActiveTabData()}
          disabled={loading || !!readOnlyLoading}
        >
          {loading || readOnlyLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <p style={{ color: "crimson", fontWeight: 700 }}>{error}</p>}

      {activeTab === "Dashboard" && (
        <section>
          <h2>Business Snapshot</h2>
          <p style={{ marginTop: 0, color: "#395946" }}>
            High-level KPIs with weekly trend intelligence (last {dashboardWeeksBack} weeks, Sunday–Saturday buckets).{" "}
            <strong>Click any KPI card</strong> (here or below) for a detailed popup. Use the button for the full lifetime summary panel.
          </p>
          <button
            type="button"
            onClick={() => setDashboardLifetimeOpen((v) => !v)}
            style={{
              display: "block",
              width: "100%",
              maxWidth: 720,
              marginBottom: 12,
              padding: "12px 16px",
              borderRadius: 12,
              border: dashboardLifetimeOpen ? "2px solid #1f4d37" : "2px dashed #7cb89a",
              background: dashboardLifetimeOpen ? "#e8f5e9" : "#f7fbf8",
              color: "#1f4d37",
              fontWeight: 700,
              fontSize: 15,
              cursor: "pointer",
              textAlign: "left"
            }}
          >
            {dashboardLifetimeOpen ? "▼ Hide lifetime totals (all time)" : "► Show lifetime totals (all time)"}
            <span style={{ display: "block", marginTop: 4, fontWeight: 500, fontSize: 13, opacity: 0.9 }}>
              Sales, tax, COGS, profit, lbs, order mix, expenses by category, top products, invoices, and report P&amp;L.
            </span>
          </button>
          {dashboardLifetimeOpen && (
            <div
              style={{
                marginBottom: 16,
                padding: 16,
                borderRadius: 14,
                border: "1px solid #9ec1ac",
                background: "linear-gradient(180deg, #f4fff7 0%, #fff 48%)",
                boxShadow: "0 8px 24px rgba(31, 77, 55, 0.08)"
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: 12, color: "#1f4d37" }}>Lifetime snapshot (all recorded history)</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
                {(
                  [
                    { label: "Sales (tax incl.)", drill: { type: "orders-money-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.salesTaxIncl} /> },
                    { label: "Net sales", drill: { type: "orders-money-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.netSales} /> },
                    { label: "Sales tax (est.)", drill: { type: "orders-money-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.taxCollected} /> },
                    {
                      label: "COGS (food cost)",
                      drill: { type: "orders-money-lifetime" as const },
                      node: <SignedMoney value={dashboardLifetimeStats.totalCogs} />
                    },
                    { label: "Gross profit", drill: { type: "orders-money-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.totalProfit} /> },
                    { label: "Expenses (all)", drill: { type: "expenses-all" as const }, node: <SignedMoney value={dashboardLifetimeStats.expenseTotal} /> },
                    {
                      label: "Operating expenses (P&L)",
                      drill: { type: "pnl-books" as const },
                      node: <SignedMoney value={dashboardLifetimeStats.expenseOperatingForPnl} />
                    },
                    { label: "Net profit", drill: { type: "net-after-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.netAfterExpenses} /> },
                    { label: "Active orders", drill: { type: "orders-active-lifetime" as const }, node: <strong>{dashboardLifetimeStats.activeOrders}</strong> },
                    { label: "Cancelled", drill: { type: "orders-cancelled-lifetime" as const }, node: <strong>{dashboardLifetimeStats.cancelledOrders}</strong> },
                    { label: "Pending (NEW/CONF.)", drill: { type: "orders-pending-lifetime" as const }, node: <strong>{dashboardLifetimeStats.pendingPipeline}</strong> },
                    { label: "Fulfilled", drill: { type: "orders-fulfilled-lifetime" as const }, node: <strong>{dashboardLifetimeStats.fulfilled}</strong> },
                    { label: "Orders marked paid", drill: { type: "orders-paid-lifetime" as const }, node: <strong>{dashboardLifetimeStats.paidOrders}</strong> },
                    { label: "Total lbs sold", drill: { type: "lbs-recipe-lifetime" as const }, node: <strong>{dashboardLifetimeStats.totalLbs.toFixed(2)}</strong> },
                    { label: "Avg order (tax incl.)", drill: { type: "orders-money-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.avgOrderTaxIncl} /> },
                    { label: "Profit / lb", drill: { type: "lbs-recipe-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.profitPerLb} /> },
                    { label: "Net $ / lb", drill: { type: "lbs-recipe-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.netPerLb} /> },
                    { label: "Margin % (on net)", drill: { type: "orders-money-lifetime" as const }, node: <PctColored value={dashboardLifetimeStats.marginPct} /> },
                    { label: "Expense ratio %", drill: { type: "net-after-lifetime" as const }, node: <PctColored value={dashboardLifetimeStats.expenseRatioPct} /> },
                    { label: "Customers (w/ orders)", drill: { type: "customers-activity" as const }, node: <strong>{dashboardLifetimeStats.uniqueCustomersWithOrders}</strong> },
                    { label: "Customer records", drill: { type: "customers" as const }, node: <strong>{dashboardLifetimeStats.customerRecordsCount}</strong> },
                    { label: "Invoices (on orders)", drill: { type: "orders-with-invoice-lifetime" as const }, node: <strong>{dashboardLifetimeStats.invoicesOnOrders}</strong> },
                    { label: "Invoiced $ (orders)", drill: { type: "orders-with-invoice-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.invoicedAmount} /> },
                    { label: "Invoice records", drill: { type: "invoices-all" as const }, node: <strong>{dashboardLifetimeStats.invoiceRecordsCount}</strong> },
                    { label: "Invoices paid (records)", drill: { type: "invoices-paid" as const }, node: <strong>{dashboardLifetimeStats.invoiceRecordsPaid}</strong> },
                    { label: "Expense lines", drill: { type: "expenses-all" as const }, node: <strong>{dashboardLifetimeStats.expenseEntryCount}</strong> },
                    { label: "Inventory lots", drill: { type: "inventory-lots" as const }, node: <strong>{dashboardLifetimeStats.inventoryLotCount}</strong> },
                    { label: "Recipes", drill: { type: "recipes-all" as const }, node: <strong>{dashboardLifetimeStats.recipeCount}</strong> },
                    { label: "Ingredients", drill: { type: "ingredients-all" as const }, node: <strong>{dashboardLifetimeStats.ingredientCount}</strong> }
                  ] as const
                ).map((card) => (
                  <button
                    key={card.label}
                    type="button"
                    title={
                      String(card.label).startsWith("COGS")
                        ? "COGS (cost of goods sold) is what you paid for ingredients/food in the products you sold — not rent, labor, or other overhead."
                        : card.label === "Net profit"
                          ? "Net sales (pre-tax) minus food cost (COGS) minus operating expenses — bottom line on the orders and expenses loaded in this app."
                          : "Click for detail"
                    }
                    onClick={() => setDashboardDrill(card.drill)}
                    style={{
                      border: "1px solid #d4e4d9",
                      borderRadius: 10,
                      padding: 10,
                      background: "#fff",
                      cursor: "pointer",
                      textAlign: "left",
                      font: "inherit",
                      boxShadow: "0 1px 2px rgba(31,77,55,0.06)"
                    }}
                  >
                    <div style={{ fontSize: 10, color: "#166534", textTransform: "uppercase", letterSpacing: "0.03em" }}>{card.label}</div>
                    <div style={{ marginTop: 6, fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{card.node}</div>
                    <div style={{ marginTop: 4, fontSize: 10, color: "#14532d" }}>Click for detail</div>
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 1fr) minmax(280px, 1.2fr)", gap: 14, alignItems: "start" }}>
                <div
                  role="button"
                  tabIndex={0}
                  title="Click for all expenses (detail popup)"
                  onClick={() => setDashboardDrill({ type: "expenses-all" })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDashboardDrill({ type: "expenses-all" });
                    }
                  }}
                  style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff", cursor: "pointer" }}
                >
                  <h4 style={{ marginTop: 0 }}>Expenses by category (lifetime)</h4>
                  <p style={{ margin: "0 0 8px", fontSize: 11, color: "#14532d" }}>Click this card for full expense list</p>
                  {dashboardLifetimeStats.expenseByCategory.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13 }}>No expenses yet.</p>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                      {dashboardLifetimeStats.expenseByCategory.slice(0, 14).map((row: { category: string; total: number }) => (
                        <li key={row.category}>
                          {row.category}: <SignedMoney value={row.total} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  title="Click for lbs / recipe mix (detail popup)"
                  onClick={() => setDashboardDrill({ type: "lbs-recipe-lifetime" })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDashboardDrill({ type: "lbs-recipe-lifetime" });
                    }
                  }}
                  style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fff", overflowX: "auto", cursor: "pointer" }}
                >
                  <h4 style={{ marginTop: 0 }}>Top products (lifetime)</h4>
                  <p style={{ margin: "0 0 8px", fontSize: 11, color: "#14532d" }}>
                    Click this card for lbs sold by recipe. Qty below is estimated pounds from each order line (bags × lbs per bag when applicable).
                  </p>
                  {dashboardLifetimeStats.topItems.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13 }}>No non-cancelled orders yet.</p>
                  ) : (
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Item</th>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6 }}>Orders</th>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6 }}>Qty (lb est.)</th>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6 }}>Sales (incl.)</th>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6 }}>Gross profit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dashboardLifetimeStats.topItems.map((row: any) => (
                          <tr key={row.item}>
                            <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{row.item}</td>
                            <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "center" }}>{row.orders}</td>
                            <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{row.lbs.toFixed(1)}</td>
                            <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>
                              <SignedMoney value={row.salesTaxIncl} />
                            </td>
                            <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>
                              <SignedMoney value={row.profit} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
              <h4 style={{ marginBottom: 8 }}>Books P&amp;L (all time — same as report)</h4>
              <p style={{ marginTop: 0, fontSize: 12, color: "#64748b" }}>
                Click any line for the full P&amp;L popup. COGS = cost of goods sold (your food/ingredient cost). Net profit subtracts COGS and operating expenses from pre-tax net sales.
              </p>
              <ul style={{ margin: 0, fontSize: 14, lineHeight: 1.8, paddingLeft: 0, listStyle: "none" }}>
                <li>
                  <button type="button" onClick={() => setDashboardDrill({ type: "pnl-books" })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}>
                    Revenue (tax incl.): <SignedMoney value={pnl.revenue} />
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => setDashboardDrill({ type: "pnl-books" })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}>
                    COGS (food cost): <SignedMoney value={Number(pnl.cogs ?? 0)} />
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => setDashboardDrill({ type: "pnl-books" })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}>
                    Gross profit: <SignedMoney value={Number(pnl.grossProfit ?? 0)} />
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => setDashboardDrill({ type: "pnl-books" })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}>
                    Operating expenses: <SignedMoney value={pnl.expenses} />
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => setDashboardDrill({ type: "pnl-books" })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}>
                    Net profit: <SignedMoney value={pnl.netProfit} />
                  </button>
                </li>
              </ul>
              <p style={{ marginBottom: 0, marginTop: 10, fontSize: 12, color: "#64748b" }}>
                Order dollars use the same tax-included subtotal → net + NJ tax split as the rest of the app. Cancelled orders are excluded from sales and profit totals.
              </p>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginBottom: 12 }}>
            {(
              [
                { label: "Customers", drill: { type: "customers" as const }, node: <strong>{overview.customerCount ?? 0}</strong> },
                { label: "Orders (all-time)", drill: { type: "orders-all" as const }, node: <strong>{overview.orderCount ?? 0}</strong> },
                { label: "Expenses (all-time)", drill: { type: "expenses-all" as const }, node: <strong>{overview.expenseCount ?? 0}</strong> },
                { label: "Recipes", drill: { type: "recipes-all" as const }, node: <strong>{overview.recipeCount ?? 0}</strong> },
                { label: "Ingredients", drill: { type: "ingredients-all" as const }, node: <strong>{overview.ingredientCount ?? 0}</strong> },
                { label: `${dashboardWeeksBack}w Sales`, drill: { type: "orders-money-period" as const }, node: <SignedMoney value={dashboardWeekly.totals.salesTaxIncl} /> },
                { label: `${dashboardWeeksBack}w Net Sales`, drill: { type: "orders-money-period" as const }, node: <SignedMoney value={dashboardWeekly.totals.netSales} /> },
                { label: `${dashboardWeeksBack}w Sales Tax`, drill: { type: "orders-money-period" as const }, node: <SignedMoney value={dashboardWeekly.totals.taxCollected} /> },
                { label: `${dashboardWeeksBack}w Revenue`, drill: { type: "orders-money-period" as const }, node: <SignedMoney value={dashboardWeekly.totals.salesTaxIncl} /> },
                {
                  label: `${dashboardWeeksBack}w Op. expenses`,
                  drill: { type: "expenses-period" as const },
                  node: <SignedMoney value={dashboardWeekly.totals.expenses} />,
                  desc: "Operating expenses only; ingredient-category purchases excluded (already in COGS)."
                },
                {
                  label: `${dashboardWeeksBack}w Net profit`,
                  drill: { type: "net-after-period" as const },
                  node: <SignedMoney value={dashboardWeekly.totals.profit} />,
                  desc: "Net sales (pre-tax) minus food cost (COGS) minus operating expenses (ingredient-category purchases excluded — already in COGS), summed over the week range."
                },
                {
                  label: `${dashboardWeeksBack}w Lbs Sold`,
                  drill: { type: "lbs-recipe-period" as const },
                  node: (
                    <div style={{ marginTop: 2 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{dashboardWeekly.totals.lbs.toFixed(1)} lb total</div>
                      {dashboardPeriodLbsByRecipe.length === 0 ? (
                        <div style={{ marginTop: 4, fontSize: 11, color: "#14532d" }}>No non-cancelled lbs in this range.</div>
                      ) : (
                        <ul
                          style={{
                            margin: "6px 0 0",
                            paddingLeft: 16,
                            fontSize: 11,
                            lineHeight: 1.4,
                            maxHeight: 140,
                            overflowY: "auto",
                            color: "#14532d"
                          }}
                        >
                          {dashboardPeriodLbsByRecipe.map((row) => (
                            <li key={row.recipe} style={{ marginBottom: 3 }}>
                              <span style={{ color: "#0f172a" }}>{row.recipe}</span>
                              <span style={{ fontWeight: 700 }}> {row.lbs.toFixed(1)} lb</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                },
                {
                  label: `${dashboardWeeksBack}w Active Orders`,
                  drill: { type: "orders-active-period" as const },
                  node: <strong>{dashboardWeekly.totals.orders}</strong>,
                  desc: "Count of non-cancelled orders created in the selected week range."
                },
                {
                  label: `${dashboardWeeksBack}w Cancelled`,
                  drill: { type: "orders-cancelled-period" as const },
                  node: <strong>{dashboardWeekly.totals.cancelled}</strong>,
                  desc: "Count of cancelled orders created in the selected week range."
                },
                {
                  label: `${dashboardWeeksBack}w Profit/Lb`,
                  drill: { type: "lbs-recipe-period" as const },
                  node: <SignedMoney value={dashboardWeekly.totals.lbs > 0 ? dashboardWeekly.totals.profit / dashboardWeekly.totals.lbs : 0} />,
                  desc: "Net profit (net sales − COGS − operating expenses, excl. inventory-category purchases) divided by estimated lbs sold in the selected week range."
                }
              ] as const
            ).map((card) => (
              <button
                key={card.label}
                type="button"
                onClick={() => setDashboardDrill(card.drill)}
                title={("desc" in card && card.desc) || "Click for details and drill-down breakdown."}
                style={{
                  padding: 10,
                  borderRadius: 10,
                  border: "1px solid #cfe0d4",
                  background: "#f7fbf8",
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                  color: "#0f172a"
                }}
              >
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em", color: "#166534" }}>{card.label}</div>
                <div style={{ marginTop: 6, fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{card.node}</div>
                <div style={{ marginTop: 4, fontSize: 10, color: "#14532d" }}>{("desc" in card && card.desc) || "Click for breakdown"}</div>
              </button>
            ))}
          </div>

          <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#fff", marginBottom: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Weekly Trend Graphs</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <label style={{ fontSize: 13, color: "#395946", display: "flex", gap: 6, alignItems: "center" }}>
                  Range
                  <select
                    value={dashboardWeeksBack}
                    onChange={(e) => setDashboardWeeksBack(Number(e.target.value) as 8 | 12 | 26)}
                    style={{ padding: "4px 8px", borderRadius: 8, border: "1px solid #9ec1ac" }}
                  >
                    <option value={8}>8 weeks</option>
                    <option value={12}>12 weeks</option>
                    <option value={26}>26 weeks</option>
                  </select>
                </label>
                <label style={{ fontSize: 13, color: "#395946", display: "flex", gap: 6, alignItems: "center" }}>
                  Chart
                  <select
                    value={dashboardChartType}
                    onChange={(e) => setDashboardChartType(e.target.value as "bar" | "line")}
                    style={{ padding: "4px 8px", borderRadius: 8, border: "1px solid #9ec1ac" }}
                  >
                    <option value="bar">Bars</option>
                    <option value="line">Lines</option>
                  </select>
                </label>
              </div>
            </div>
            <p style={{ marginTop: 0, fontSize: 13, color: "#466251" }}>
              Blue = Revenue (tax incl.), Green = Net profit (net sales − COGS − expenses), Red = Expenses
            </p>
            {dashboardChartType === "bar" ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${dashboardWeeksBack}, minmax(${dashboardWeeksBack >= 20 ? 36 : 52}px, 1fr))`,
                  gap: dashboardWeeksBack >= 20 ? 4 : 8,
                  alignItems: "end",
                  minHeight: 200
                }}
              >
                {dashboardWeekly.buckets.map((w) => (
                  <button
                    key={w.start.getTime()}
                    type="button"
                    onClick={() => openDashboardWeekDrill(w)}
                    title={`Week ${w.label} — click for orders, expenses, and lbs by recipe`}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 6,
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      padding: 4,
                      borderRadius: 8,
                      font: "inherit"
                    }}
                  >
                    <div style={{ display: "flex", gap: 4, alignItems: "end", height: 140 }}>
                      <div
                        title={`Sales ${fmtMoney(w.salesTaxIncl)}`}
                        style={{
                          width: dashboardWeeksBack >= 20 ? 10 : 14,
                          height: `${(w.salesTaxIncl / dashboardWeekly.maxSales) * 100}%`,
                          minHeight: 2,
                          background: "#3b82f6",
                          borderRadius: 4
                        }}
                      />
                      <div
                        title={`Profit ${fmtMoney(w.profit)}`}
                        style={{
                          width: dashboardWeeksBack >= 20 ? 10 : 14,
                          height: `${(Math.max(0, w.profit) / dashboardWeekly.maxProfit) * 100}%`,
                          minHeight: 2,
                          background: "#16a34a",
                          borderRadius: 4
                        }}
                      />
                      <div
                        title={`Expenses ${fmtMoney(w.expenses)}`}
                        style={{
                          width: dashboardWeeksBack >= 20 ? 10 : 14,
                          height: `${(w.expenses / dashboardWeekly.maxExpenses) * 100}%`,
                          minHeight: 2,
                          background: "#ef4444",
                          borderRadius: 4
                        }}
                      />
                    </div>
                    <div style={{ fontSize: dashboardWeeksBack >= 20 ? 9 : 11, color: "#4d6657", textAlign: "center", lineHeight: 1.1 }}>{w.label}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ width: "100%", overflowX: "auto" }}>
                {(() => {
                  const n = dashboardWeekly.buckets.length;
                  const W = 880;
                  const H = 200;
                  const padL = 44;
                  const padR = 20;
                  const midY = H / 2;
                  const amp = midY - 18;
                  const sm = dashboardWeekly.lineScaleMax;
                  const xAt = (i: number) => {
                    if (n <= 1) return (padL + W - padR) / 2;
                    return padL + (i / (n - 1)) * (W - padL - padR);
                  };
                  const yAt = (v: number) => midY - (v / sm) * amp;
                  const pts = (vals: number[]) => vals.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ");
                  const stripW =
                    n <= 1 ? W - padL - padR : Math.min(36, Math.max(14, ((W - padL - padR) / (n - 1)) * 0.5));
                  const salesVals = dashboardWeekly.buckets.map((w) => w.salesTaxIncl);
                  const profitVals = dashboardWeekly.buckets.map((w) => w.profit);
                  const expVals = dashboardWeekly.buckets.map((w) => w.expenses);
                  return (
                    <div>
                      <svg
                        viewBox={`0 0 ${W} ${H}`}
                        preserveAspectRatio="xMidYMid meet"
                        style={{ width: "100%", maxWidth: "100%", height: "auto", display: "block" }}
                        role="img"
                        aria-label="Weekly sales profit expenses trend"
                      >
                        <defs>
                          <linearGradient id="dashLineBg" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#f0fdf4" stopOpacity="0.9" />
                            <stop offset="100%" stopColor="#ffffff" stopOpacity="1" />
                          </linearGradient>
                        </defs>
                        <rect x="0" y="0" width={W} height={H} fill="url(#dashLineBg)" rx="8" />
                        <line x1={padL} y1={midY} x2={W - padR} y2={midY} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 4" />
                        <text x={padL} y={16} fontSize="11" fill="#64748b">
                          ±${fmtMoney(sm)} scale
                        </text>
                        <polyline fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={pts(salesVals)} />
                        <polyline fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={pts(profitVals)} />
                        <polyline fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={pts(expVals)} />
                        {dashboardWeekly.buckets.map((w, i) => (
                          <rect
                            key={`week-hit-${w.start.getTime()}`}
                            x={xAt(i) - stripW / 2}
                            y={2}
                            width={stripW}
                            height={H - 22}
                            fill="transparent"
                            style={{ cursor: "pointer" }}
                            onClick={() => openDashboardWeekDrill(w)}
                          />
                        ))}
                      </svg>
                      <div style={{ display: "flex", marginTop: 6, paddingLeft: 4, paddingRight: 4, gap: 2 }}>
                        {dashboardWeekly.buckets.map((w) => (
                          <button
                            key={w.start.getTime()}
                            type="button"
                            onClick={() => openDashboardWeekDrill(w)}
                            title={`Week ${w.label} — click for details`}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: dashboardWeeksBack >= 20 ? 8 : 10,
                              color: "#4d6657",
                              textAlign: "center",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              border: "none",
                              background: "transparent",
                              cursor: "pointer",
                              padding: "2px 0",
                              font: "inherit"
                            }}
                          >
                            {w.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
            <div style={{ marginTop: 12, borderTop: "1px dashed #cfe0d4", paddingTop: 10 }}>
              <h4 style={{ margin: "0 0 8px", color: "#14532d" }}>Leaderboard</h4>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
                <div style={{ border: "1px solid #d9e7df", borderRadius: 10, padding: 8, background: "#f8fffa" }}>
                  <div style={{ fontSize: 11, color: "#166534", textTransform: "uppercase" }}>Best Week Net</div>
                  <div style={{ fontWeight: 700 }}>
                    {dashboardLeaderboards.bestWeekNet?.label || "—"} ·{" "}
                    <SignedMoney value={dashboardLeaderboards.bestWeekNet?.netAfterExpenses || 0} />
                  </div>
                </div>
                <div style={{ border: "1px solid #d9e7df", borderRadius: 10, padding: 8, background: "#f8fffa" }}>
                  <div style={{ fontSize: 11, color: "#166534", textTransform: "uppercase" }}>Best Month Net</div>
                  <div style={{ fontWeight: 700 }}>
                    {dashboardLeaderboards.bestMonthNet?.label || "—"} ·{" "}
                    <SignedMoney value={dashboardLeaderboards.bestMonthNet?.netAfterExpenses || 0} />
                  </div>
                </div>
                <div style={{ border: "1px solid #d9e7df", borderRadius: 10, padding: 8, background: "#f8fffa" }}>
                  <div style={{ fontSize: 11, color: "#166534", textTransform: "uppercase" }}>Most Weight / Week</div>
                  <div style={{ fontWeight: 700 }}>
                    {dashboardLeaderboards.bestWeekLbs?.label || "—"} · {Number(dashboardLeaderboards.bestWeekLbs?.lbs || 0).toFixed(1)} lb
                  </div>
                </div>
                <div style={{ border: "1px solid #d9e7df", borderRadius: 10, padding: 8, background: "#f8fffa" }}>
                  <div style={{ fontSize: 11, color: "#166534", textTransform: "uppercase" }}>Most Weight / Month</div>
                  <div style={{ fontWeight: 700 }}>
                    {dashboardLeaderboards.bestMonthLbs?.label || "—"} · {Number(dashboardLeaderboards.bestMonthLbs?.lbs || 0).toFixed(1)} lb
                  </div>
                </div>
                <div style={{ border: "1px solid #d9e7df", borderRadius: 10, padding: 8, background: "#f8fffa" }}>
                  <div style={{ fontSize: 11, color: "#166534", textTransform: "uppercase" }}>Top Sales Week</div>
                  <div style={{ fontWeight: 700 }}>
                    {dashboardLeaderboards.bestWeekSales?.label || "—"} ·{" "}
                    <SignedMoney value={dashboardLeaderboards.bestWeekSales?.sales || 0} />
                  </div>
                </div>
                <div style={{ border: "1px solid #d9e7df", borderRadius: 10, padding: 8, background: "#f8fffa" }}>
                  <div style={{ fontSize: 11, color: "#166534", textTransform: "uppercase" }}>Top Sales Month</div>
                  <div style={{ fontWeight: 700 }}>
                    {dashboardLeaderboards.bestMonthSales?.label || "—"} ·{" "}
                    <SignedMoney value={dashboardLeaderboards.bestMonthSales?.sales || 0} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#fff", overflowX: "auto", marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Weekly Breakdown</h3>
            <p style={{ marginTop: 0, marginBottom: 10, fontSize: 12, color: "#64748b" }}>
              Click a row (or a week in the chart above) to open that week&apos;s orders, expenses, and lbs by recipe.
            </p>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "left" }}>Week</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Orders</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Cancelled</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Lbs</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Sales (incl tax)</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Net Sales</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Sales Tax</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>COGS</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Expenses</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Net profit</th>
                </tr>
              </thead>
              <tbody>
                {dashboardWeekly.buckets.map((w) => (
                  <tr
                    key={w.start.getTime()}
                    role="button"
                    tabIndex={0}
                    aria-label={`Week ${w.label}, open breakdown`}
                    onClick={() => openDashboardWeekDrill(w)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDashboardWeekDrill(w);
                      }
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <td style={{ border: "1px solid #cfd8d1", padding: 6 }}>{w.label}</td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "center" }}>{w.orders}</td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "center" }}>{w.cancelled}</td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "right" }}>{w.lbs.toFixed(1)}</td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "right" }}><SignedMoney value={w.salesTaxIncl} /></td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "right" }}><SignedMoney value={w.netSales} /></td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "right" }}><SignedMoney value={w.taxCollected} /></td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "right" }}><SignedMoney value={w.cogs} /></td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "right" }}><SignedMoney value={w.expenses} /></td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "right" }}><SignedMoney value={w.profit} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Profit and Loss (All Time)</h3>
          <p style={{ marginTop: 0, fontSize: 12, color: "#64748b" }}>
            Click any line for the books P&amp;L popup (same as the lifetime panel). COGS = food/ingredient cost; net profit includes it.
          </p>
          <ul style={{ margin: 0, fontSize: 14, lineHeight: 1.8, paddingLeft: 0, listStyle: "none" }}>
            <li>
              <button
                type="button"
                onClick={() => setDashboardDrill({ type: "pnl-books" })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}
              >
                Revenue (tax incl.): <SignedMoney value={pnl.revenue} />
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setDashboardDrill({ type: "pnl-books" })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}
              >
                COGS (food cost): <SignedMoney value={Number(pnl.cogs ?? 0)} />
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setDashboardDrill({ type: "pnl-books" })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}
              >
                Gross profit: <SignedMoney value={Number(pnl.grossProfit ?? 0)} />
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setDashboardDrill({ type: "pnl-books" })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}
              >
                Operating expenses: <SignedMoney value={pnl.expenses} />
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setDashboardDrill({ type: "pnl-books" })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}
              >
                Net profit: <SignedMoney value={pnl.netProfit} />
              </button>
            </li>
          </ul>
        </section>
      )}

      {activeTab === "Customers" && (
        <section>
          <h2>Customers</h2>
          <p style={{ marginTop: 0, maxWidth: 720, color: "#395946" }}>
            This list is built from people who have orders on <strong>Pending</strong> or <strong>Archive</strong> — new customers are added when you create orders (Submit Order / Pending Orders). There is no separate &quot;add customer&quot; step here.
          </p>
          <div style={{ marginTop: 10, marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                placeholder="Type name, email, or phone (ex: 908)"
                value={customerLookupDraft}
                onChange={(e) => setCustomerLookupDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runCustomerSearch(customerLookupDraft);
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                style={{ minWidth: 360 }}
              />
              <button
                type="button"
                onClick={() => void runCustomerSearch(customerLookupDraft)}
                disabled={customerSearchLoading}
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: "1px solid #166534",
                  background: customerSearchLoading ? "#e2e8f0" : "#dcfce7",
                  color: customerSearchLoading ? "#64748b" : "#14532d",
                  fontWeight: 700,
                  cursor: customerSearchLoading ? "not-allowed" : "pointer"
                }}
              >
                {customerSearchLoading ? "Searching..." : "Search Customers"}
              </button>
              {customerLookupQuery ? (
                <button
                  type="button"
                  onClick={() => {
                    setCustomerLookupDraft("");
                    setCustomerLookupQuery("");
                    setSelectedCustomerLookupId("");
                  }}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 8,
                    border: "1px solid #94a3b8",
                    background: "#fff",
                    color: "#334155",
                    fontWeight: 600,
                    cursor: "pointer"
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            {customerSearchSuggestions.length > 0 ? (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6, maxWidth: 520 }}>
                {customerSearchSuggestions.map((s: any) => (
                  <button
                    key={s.customer.id}
                    type="button"
                    onClick={() => {
                      const exact = String(s.customer.phone || s.customer.email || s.customer.name || "").trim();
                      setCustomerLookupDraft(exact);
                      setCustomerLookupQuery(exact);
                      setSelectedCustomerLookupId(s.customer.id);
                    }}
                    style={{
                      textAlign: "left",
                      border: "1px solid #d4e4d9",
                      background: "#fff",
                      borderRadius: 8,
                      padding: "8px 10px",
                      cursor: "pointer"
                    }}
                  >
                    <strong>{s.customer.name || "Unknown"}</strong> · {s.customer.phone || "no phone"} · {s.customer.email || "no email"}
                  </button>
                ))}
              </div>
            ) : null}
            <p style={{ marginTop: 6, marginBottom: 0, fontSize: 13, color: "#3d5c45" }}>
              Search runs only when you press <strong>Search</strong> (or pick an option above). Typing <strong>908</strong> shows matching phone options; click one to run an exact search for that customer. Results below use archived/completed orders.
            </p>
          </div>
          {!customerLookupQuery.trim() ? (
            <p style={{ color: "#5a6b5f" }}>Type a query and press Search.</p>
          ) : customerLookupDraft.trim() !== customerLookupQuery.trim() ? (
            <p style={{ color: "#5a6b5f" }}>Draft changed — press Search Customers to run this new query.</p>
          ) : customerLookupRows.length === 0 ? (
            <p>No matching customers for &quot;{customerLookupQuery.trim()}&quot;.</p>
          ) : (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
                alignItems: "start"
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: "1 1 260px", minWidth: 240, maxWidth: 420 }}>
                {customerLookupRows.map((row: any) => {
                  const sel = row.customer.id === selectedCustomerLookupId;
                  return (
                    <button
                      key={row.customer.id}
                      type="button"
                      onClick={() =>
                        setSelectedCustomerLookupId((id) => (id === row.customer.id ? "" : row.customer.id))
                      }
                      style={{
                        textAlign: "left",
                        cursor: "pointer",
                        border: sel ? "2px solid #2d6a4f" : "1px solid #d4e4d9",
                        borderRadius: 10,
                        padding: 12,
                        background: sel ? "#e8f5e9" : "#fff",
                        font: "inherit"
                      }}
                    >
                      <strong>{row.customer.name}</strong>
                      <div style={{ fontSize: 13, marginTop: 4, color: "#444" }}>
                        {row.customer.email || "no email"} · {row.customer.phone || "no phone"}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, color: "#2d6a4f" }}>
                        {row.orders.length} order(s)
                        {(() => {
                          const pend = row.orders.filter((o: any) => o.status === "NEW" || o.status === "CONFIRMED").length;
                          return pend > 0 ? (
                            <span style={{ marginLeft: 6, color: "#92400e", fontWeight: 700 }}>
                              · {pend} pending (not complete)
                            </span>
                          ) : null;
                        })()}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div style={{ flex: "2 1 320px", minWidth: 280 }}>
                {!selectedCustomerLookupId || !selectedCustomerAggregate ? (
                  <div
                    style={{
                      border: "1px dashed #cfe0d4",
                      borderRadius: 10,
                      padding: 20,
                      background: "#fafcfa",
                      color: "#5a6b5f"
                    }}
                  >
                    Select a customer to view total sales, profit, tax collected, lbs, order mix, and invoice summary.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ border: "1px solid #d4e4d9", borderRadius: 10, padding: 12, background: "#fff" }}>
                      <h3 style={{ margin: "0 0 8px 0", fontSize: 18 }}>{selectedCustomerRecord?.name ?? "Customer"}</h3>
                      <div style={{ fontSize: 13, color: "#444" }}>
                        {selectedCustomerRecord?.email || "—"} · {selectedCustomerRecord?.phone || "—"}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                        gap: 10
                      }}
                    >
                      {[
                        { label: "Total sales (tax incl.)", node: <SignedMoney value={selectedCustomerAggregate.totalTaxIncl} /> },
                        { label: "Net sales (after tax)", node: <SignedMoney value={selectedCustomerAggregate.netSales} /> },
                        { label: "NJ sales tax (est.)", node: <SignedMoney value={selectedCustomerAggregate.salesTax} /> },
                        { label: "COGS (sum)", node: <SignedMoney value={selectedCustomerAggregate.totalCogs} /> },
                        { label: "Total profit", node: <SignedMoney value={selectedCustomerAggregate.totalProfit} /> },
                        { label: "Profit / lb", node: <SignedMoney value={selectedCustomerAggregate.profitPerLb} /> },
                        { label: "Net $ / lb", node: <SignedMoney value={selectedCustomerAggregate.netPerLb} /> },
                        { label: "Margin % (on net)", node: <span>{selectedCustomerAggregate.marginPctOfNet.toFixed(1)}%</span> },
                        { label: "Orders", node: <span>{selectedCustomerAggregate.orderCount}</span> },
                        { label: "Lbs sold (sum)", node: <span>{selectedCustomerAggregate.totalLbs.toFixed(2)}</span> },
                        { label: "Avg order (tax incl.)", node: <SignedMoney value={selectedCustomerAggregate.avgOrderTaxIncl} /> },
                        {
                          label: "Status mix",
                          node: (
                            <span style={{ fontSize: 12 }}>
                              P {selectedCustomerAggregate.pending} · F {selectedCustomerAggregate.fulfilled} · C{" "}
                              {selectedCustomerAggregate.cancelled}
                            </span>
                          )
                        },
                        {
                          label: "Invoices",
                          node: (
                            <span style={{ fontSize: 12 }}>
                              {selectedCustomerAggregate.invoicesCount} · <SignedMoney value={selectedCustomerAggregate.invoicedAmount} /> billed
                            </span>
                          )
                        }
                      ].map((card) => (
                        <div
                          key={card.label}
                          style={{
                            border: "1px solid #e0ebe3",
                            borderRadius: 8,
                            padding: 10,
                            background: "#f7fbf8"
                          }}
                        >
                          <div style={{ fontSize: 11, color: "#5a6b5f", textTransform: "uppercase", letterSpacing: "0.03em" }}>{card.label}</div>
                          <div style={{ marginTop: 6, fontWeight: 600, fontSize: 15 }}>{card.node}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ border: "1px solid #d4e4d9", borderRadius: 10, padding: 12, background: "#fff" }}>
                      <h4 style={{ margin: "0 0 8px 0" }}>Order history</h4>
                      {selectedCustomerAggregate.orderCount === 0 ? (
                        <p style={{ margin: 0 }}>No orders yet.</p>
                      ) : (
                        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", fontSize: 13 }}>
                          {orders
                            .filter((o: any) => o.customerId === selectedCustomerLookupId)
                            .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                            .map((o: any) => {
                              const m = orderMetrics(o);
                              const pendingRow = o.status === "NEW" || o.status === "CONFIRMED";
                              return (
                                <li
                                  key={o.id}
                                  style={{
                                    marginBottom: 8,
                                    padding: "10px 12px",
                                    borderRadius: 8,
                                    border: pendingRow ? "1px solid #facc15" : "1px solid #e5e7eb",
                                    background: pendingRow ? "#fff6cc" : "#f9fafb"
                                  }}
                                >
                                  {pendingRow ? (
                                    <span
                                      style={{
                                        display: "inline-block",
                                        marginBottom: 4,
                                        fontSize: 10,
                                        fontWeight: 800,
                                        letterSpacing: "0.04em",
                                        color: "#92400e",
                                        background: "#fde047",
                                        padding: "2px 8px",
                                        borderRadius: 4
                                      }}
                                    >
                                      PENDING — NOT COMPLETE
                                    </span>
                                  ) : null}
                                  <div>
                                    {new Date(o.createdAt).toLocaleString()} · <strong>{o.status}</strong> · {m.lbs.toFixed(1)} lb · Total{" "}
                                    <SignedMoney value={m.subtotal} /> (incl. tax) · Net <SignedMoney value={m.netRevenue} /> · Tax{" "}
                                    <SignedMoney value={m.salesTax} /> · Profit <SignedMoney value={m.profitTotal} /> (
                                    <SignedMoney value={m.profitPerLb} />
                                    /lb)
                                    {o.notes ? ` · ${o.notes}` : ""}
                                    {o.invoice ? ` · Invoice #${o.invoice.invoiceNumber ?? "—"}` : ""}
                                  </div>
                                </li>
                              );
                            })}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {activeTab === "Products" && (
        <section>
          <h2>Products</h2>
          <p style={{ marginTop: 0, maxWidth: 900 }}>
            Define each product’s cost, pricing, and <strong>ingredient mix</strong> here (type names directly—like the sheet—or pick from suggestions). Ingredient{" "}
            <strong>inventory</strong> (purchases and on-hand qty/cost) is below the product list.
          </p>
          <p>Set cost per lb, then choose charge per lb or per bag. Dog food can stay per lb; treats can be charged per bag with amount per unit.</p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              placeholder="Search products or ingredient names in the mix..."
              value={recipeSearch}
              onChange={(e) => setRecipeSearch(e.target.value)}
              style={{ minWidth: 300 }}
            />
            <select value={recipeFoodTypeFilter} onChange={(e) => setRecipeFoodTypeFilter(e.target.value as "ALL" | "Adult" | "Puppy" | "Specialty" | "Treats")}>
              <option value="ALL">Food Type: All</option>
              <option value="Adult">Adult</option>
              <option value="Puppy">Puppy</option>
              <option value="Specialty">Specialty</option>
              <option value="Treats">Treats</option>
            </select>
            <select value={recipeSortBy} onChange={(e) => setRecipeSortBy(e.target.value as "margin" | "name" | "costPerPound" | "salePrice" | "unit" | "amountPerUnit" | "foodType")}>
              <option value="name">Sort By: Product</option>
              <option value="margin">Sort By: Margin %</option>
              <option value="costPerPound">Sort By: Cost Per lb</option>
              <option value="salePrice">Sort By: Charge $</option>
              <option value="unit">Sort By: Unit</option>
              <option value="amountPerUnit">Sort By: Amount per Unit</option>
              <option value="foodType">Sort By: Food Type</option>
            </select>
            <select value={recipeSortDirection} onChange={(e) => setRecipeSortDirection(e.target.value as "asc" | "desc")}>
              <option value="asc">Order: Low -&gt; High / A -&gt; Z</option>
              <option value="desc">Order: High -&gt; Low / Z -&gt; A</option>
            </select>
            <span style={{ fontSize: 13, color: "#475569" }}>{filteredRecipes.length} shown</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setRecipeSaveNotice("");
              const ingredientsPayload = sortRecipeLinesForSave(recipeLines)
                .filter((line) => line.ingredientName.trim() && parseRecipeRatioInput(line.quantity) > 0)
                .map((line) => ({
                  ingredientId: line.ingredientName.trim(),
                  quantity: parseRecipeRatioInput(line.quantity)
                }));
              const bundlePayload = bundleLines
                .filter((line) => line.ingredientId && parseRecipeRatioInput(line.quantity) > 0)
                .map((line) => ({
                  ingredientId: line.ingredientId,
                  quantity: parseRecipeRatioInput(line.quantity)
                }));
              const body = {
                ...recipeForm,
                costPerPound: Number(recipeForm.isBundle ? recipeForm.costPerPound : recipeCalculator.weightedCost),
                salePrice: Number(recipeForm.salePrice),
                chargeUnit: recipeForm.chargeUnit === "bag" ? "bag" : "lb",
                amountPerUnit: Number(recipeForm.amountPerUnit || 1),
                isBundle: Boolean(recipeForm.isBundle),
                ingredients: ingredientsPayload,
                bundleItems: bundlePayload
              };
              if (!body.isBundle && body.ingredients.length === 0) {
                setError("No valid ingredient ratios were detected. Enter numeric values like 0.75 (or 0,75), then submit again.");
                return;
              }
              const recipeConfirm = false;
              void submit(
                async () => {
                  setRecipeSubmitting(true);
                  try {
                    if (editingRecipeId) {
                      await apiPut(`/operations/recipes/${editingRecipeId}/full`, body);
                      const freshRecipes = await apiGetRecipes();
                      const fresh = freshRecipes.find((r: any) => r.id === editingRecipeId);
                      if (fresh) loadRecipeForEdit(fresh);
                      setRecipeSaveNotice(`Product updated: ${body.name}`);
                    } else {
                      const createdRecipe: any = await apiPost("/operations/recipes/full", body);
                      const freshRecipes = await apiGetRecipes();
                      const fresh = freshRecipes.find((r: any) => r.id === createdRecipe?.id);
                      if (fresh) loadRecipeForEdit(fresh);
                      setRecipeSaveNotice(`Product created: ${body.name}`);
                    }
                  } finally {
                    setRecipeSubmitting(false);
                  }
                },
                recipeConfirm
              );
            }}
          >
            {editingRecipeId ? (
              <div style={{ marginBottom: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid #a7f3d0", background: "#ecfdf5", color: "#14532d" }}>
                Editing product: <strong>{recipeForm.name || "(unnamed)"}</strong>
              </div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1.8fr 1fr 1fr 1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
              <input placeholder="Product name" value={recipeForm.name} onChange={(e) => setRecipeForm({ ...recipeForm, name: e.target.value })} required />
              <input placeholder="Description" value={recipeForm.description} onChange={(e) => setRecipeForm({ ...recipeForm, description: e.target.value })} />
              <select value={recipeForm.foodType} onChange={(e) => setRecipeForm({ ...recipeForm, foodType: e.target.value })}>
                <option value="Adult">Adult</option>
                <option value="Puppy">Puppy</option>
                <option value="Specialty">Specialty</option>
                <option value="Treats">Treats</option>
              </select>
              <input placeholder="Cost/lb" type="number" step="0.01" value={recipeForm.costPerPound} onChange={(e) => setRecipeForm({ ...recipeForm, costPerPound: e.target.value })} required />
              <input
                placeholder={recipeForm.chargeUnit === "bag" ? "Charge/bag" : "Charge/lb"}
                type="number"
                step="0.01"
                value={recipeForm.salePrice}
                onChange={(e) => setRecipeForm({ ...recipeForm, salePrice: e.target.value })}
                required
              />
              <select value={recipeForm.chargeUnit} onChange={(e) => setRecipeForm({ ...recipeForm, chargeUnit: e.target.value })}>
                <option value="lb">Per lb (food)</option>
                <option value="bag">Per bag (treats)</option>
              </select>
              <input
                placeholder={recipeForm.chargeUnit === "bag" ? "Amount per bag (lb)" : "Amount per unit"}
                type="number"
                step="0.01"
                value={recipeForm.amountPerUnit}
                onChange={(e) => setRecipeForm({ ...recipeForm, amountPerUnit: e.target.value })}
                required
              />
            </div>
            {editingRecipeId ? (
              <div style={{ marginBottom: 8 }}>
                <button type="button" onClick={() => resetRecipeEditor()}>
                  Cancel Edit
                </button>
              </div>
            ) : null}
            {recipeSaveNotice ? <div style={{ marginBottom: 8, color: "#166534", fontWeight: 700 }}>{recipeSaveNotice}</div> : null}
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={recipeForm.isBundle}
                onChange={(e) => setRecipeForm({ ...recipeForm, isBundle: e.target.checked })}
              />
              Bundle product (contains other products, e.g. Dog Flight)
            </label>

            <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 8, marginBottom: 8 }}>
              <strong>Ingredients and ratio (%)</strong>
              <datalist id="jr-product-ingredient-suggestions">
                {ingredientsForSelect.map((i) => (
                  <option key={i.id} value={i.name} />
                ))}
              </datalist>
              {recipeLines.map((line, idx) => (
                <div key={`line-${idx}`} style={{ display: "grid", gridTemplateColumns: "120px 2fr 1fr", gap: 8, marginTop: 6 }}>
                  <label>Line {idx + 1}</label>
                  <input
                    list="jr-product-ingredient-suggestions"
                    placeholder="Ingredient name (type or choose suggestion)"
                    value={line.ingredientName}
                    onChange={(e) => {
                      const next = [...recipeLines];
                      next[idx] = { ...next[idx], ingredientName: e.target.value };
                      setRecipeLines(next);
                    }}
                    autoComplete="off"
                  />
                  <input
                    placeholder="Ratio %"
                    type="number"
                    step="0.0001"
                    value={line.quantity}
                    onChange={(e) => {
                      const next = [...recipeLines];
                      next[idx] = { ...next[idx], quantity: e.target.value };
                      setRecipeLines(next);
                    }}
                  />
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => setRecipeLines([...recipeLines, { ingredientName: "", quantity: "" }])}
                >
                  + Add ingredient line
                </button>
                <button
                  type="button"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    const fromIngredients = ingredientsForSelect
                      .filter((i: any) => Number(i.percentAdded || 0) > 0)
                      .map((i: any) => ({
                        ingredientName: i.name,
                        quantity: String(Number(i.percentAdded))
                      }));
                    setRecipeLines(fromIngredients.length ? fromIngredients : blankRecipeLines);
                  }}
                >
                  Load from inventory “% Added” column
                </button>
                <button
                  type="button"
                  style={{ marginLeft: 8 }}
                  onClick={() =>
                    setRecipeForm((prev) => ({
                      ...prev,
                      costPerPound: recipeCalculator.weightedCost.toFixed(2),
                      salePrice:
                        prev.chargeUnit === "bag"
                          ? (recipeCalculator.weightedCharge * Math.max(0.01, Number(prev.amountPerUnit || 1))).toFixed(2)
                          : recipeCalculator.weightedCharge.toFixed(2)
                    }))
                  }
                >
                  Apply Calculator To Cost/Charge
                </button>
                {recipeLines.length > 1 && (
                  <button
                    type="button"
                    style={{ marginLeft: 8 }}
                    onClick={() => setRecipeLines(recipeLines.slice(0, -1))}
                  >
                    - Remove Last Line
                  </button>
                )}
              </div>
              <div style={{ marginTop: 10, fontSize: 14 }}>
                <strong>Calculator:</strong>{" "}
                lines={recipeCalculator.lineCount} | total ratio={recipeCalculator.totalPercent.toFixed(2)}% | calculated cost/lb:{" "}
                <SignedMoney value={recipeCalculator.weightedCost} /> | calculated charge/lb: <SignedMoney value={recipeCalculator.weightedCharge} />
              </div>
              {editingRecipeId ? (
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 13,
                    fontWeight: 700,
                    color: Math.abs(recipePercentDeltaTo100) <= 0.01 ? "#166534" : "#b45309"
                  }}
                >
                  Edit ratio check: {recipeCalculator.totalPercent.toFixed(2)}% total
                  {Math.abs(recipePercentDeltaTo100) <= 0.01
                    ? " (perfect 100%)"
                    : ` (${recipePercentDeltaTo100 > 0 ? recipePercentDeltaTo100.toFixed(2) + "% missing" : Math.abs(recipePercentDeltaTo100).toFixed(2) + "% over"})`}
                </div>
              ) : null}
            </div>
            {recipeForm.isBundle && (
              <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 8, marginBottom: 8 }}>
                <strong>Bundle items (other products)</strong>
                {bundleLines.map((line, idx) => (
                  <div key={`bundle-${idx}`} style={{ display: "grid", gridTemplateColumns: "120px 2fr 1fr", gap: 8, marginTop: 6 }}>
                    <label>Product {idx + 1}</label>
                    <select
                      value={line.ingredientId}
                      onChange={(e) => {
                        const next = [...bundleLines];
                        next[idx] = { ...next[idx], ingredientId: e.target.value };
                        setBundleLines(next);
                      }}
                    >
                      <option value="">Select product</option>
                      {recipesForSelect
                        .filter((r: any) => r.id !== editingRecipeId)
                        .map((r: any) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                    </select>
                    <input
                      placeholder="Quantity (units)"
                      type="number"
                      step="0.01"
                      value={line.quantity}
                      onChange={(e) => {
                        const next = [...bundleLines];
                        next[idx] = { ...next[idx], quantity: e.target.value };
                        setBundleLines(next);
                      }}
                    />
                  </div>
                ))}
                <div style={{ marginTop: 8 }}>
                  <button type="button" onClick={() => setBundleLines([...bundleLines, { ingredientId: "", quantity: "" }])}>
                    + Add bundle product
                  </button>
                  {bundleLines.length > 1 && (
                    <button type="button" style={{ marginLeft: 8 }} onClick={() => setBundleLines(bundleLines.slice(0, -1))}>
                      − Remove last bundle line
                    </button>
                  )}
                  <button
                    type="button"
                    style={{ marginLeft: 8 }}
                    onClick={() =>
                      setRecipeForm((prev) => ({
                        ...prev,
                        costPerPound: recipeCalculator.bundleCost.toFixed(2),
                        salePrice: recipeCalculator.bundleCharge.toFixed(2),
                        chargeUnit: "bag",
                        amountPerUnit: "1"
                      }))
                    }
                  >
                    Calculate From Bundle Items
                  </button>
                </div>
                <div style={{ marginTop: 10, fontSize: 14 }}>
                  <strong>Bundle Calc:</strong> cost/unit: <SignedMoney value={recipeCalculator.bundleCost} /> | charge/unit:{" "}
                  <SignedMoney value={recipeCalculator.bundleCharge} />
                </div>
              </div>
            )}
            {editingRecipeId && (
              <button type="button" onClick={resetRecipeEditor} disabled={recipeSubmitting}>
                Cancel Edit
              </button>
            )}
            <div style={{ marginTop: 10 }}>
              <button type="submit" disabled={recipeSubmitting}>
                {recipeSubmitting ? "Saving..." : editingRecipeId ? "Update product" : "Add product"}
              </button>
            </div>
          </form>

          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 980 }}>
              <thead>
                <tr>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Margin %</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Product</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Cost Per lb $</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Charge $</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Unit</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Amount per Unit</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Food Type</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Ingredient Mix (unlimited)</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Bundle Mix (recipes)</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {recipesForTable.map((r: any) => {
                  const unit = String(r.chargeUnit ?? "lb");
                  const amountPerUnit = Math.max(0.01, Number(r.amountPerUnit ?? 1));
                  const chargePerLb = unit === "bag" ? Number(r.salePrice) / amountPerUnit : Number(r.salePrice);
                  const computedCostPerLb = recipeComputedCostPerLb(r);
                  const costPerLbForMargin = computedCostPerLb > 0 ? computedCostPerLb : Number(r.costPerPound || 0);
                  const marginPct = costPerLbForMargin > 0 ? ((chargePerLb - costPerLbForMargin) / costPerLbForMargin) * 100 : 0;
                  const recipeIngredients = getSortedRecipeIngredients(r);
                  const bundleMix = (r.bundleItems || [])
                    .map((bi: any) => `${bi.childRecipe?.name ?? ""} (${Number(bi.quantity).toFixed(2)})`)
                    .join(", ");
                  return (
                    <tr key={r.id}>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>
                        <PctColored value={marginPct} />
                      </td>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>{r.name}</td>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>
                        <SignedMoney value={costPerLbForMargin} />
                      </td>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>
                        <SignedMoney value={r.salePrice} />
                      </td>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>{unit}</td>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>{amountPerUnit.toFixed(2)}</td>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>{r.foodType || "Adult"}</td>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>
                        {recipeIngredients.length
                          ? recipeIngredients
                              .map((ri: any) => `${ri.ingredient?.name ?? ""} (${Number(ri.quantity).toFixed(2)}%)`)
                              .join(", ")
                          : ""}
                      </td>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>{bundleMix}</td>
                      <td style={{ border: "1px solid #ccc", padding: 6 }}>
                        <button type="button" onClick={() => loadRecipeForEdit(r)}>
                          Edit
                        </button>
                        {editingRecipeId === r.id ? (
                          <span style={{ marginLeft: 6, fontSize: 12, color: "#166534", fontWeight: 700 }}>Editing now</span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            void submit(async () => {
                              await apiDelete(`/operations/recipes/${r.id}`);
                            }, {
                              title: "Confirm recipe deletion",
                              from: {
                                name: r.name,
                                foodType: r.foodType || "Adult",
                                salePrice: Number(r.salePrice || 0)
                              },
                              to: "Deleted"
                            })
                          }
                          style={{ marginLeft: 6 }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <hr style={{ margin: "32px 0", border: 0, borderTop: "1px solid #cfe0d4" }} />
          <h2 id="ingredient-inventory">Ingredient inventory</h2>
          <p style={{ maxWidth: 900 }}>
            Stock counts and purchases for ingredients you buy in bulk. Use the <strong>same spelling</strong> as on product mixes above if you want the cost calculator and
            margins to line up with inventory pricing.
          </p>
          <input
            placeholder="Search ingredients..."
            value={ingredientSearch}
            onChange={(e) => setIngredientSearch(e.target.value)}
            style={{ marginBottom: 10, minWidth: 280 }}
          />
          <h3>Purchase update (when you buy more)</h3>
          <p style={{ marginTop: 0 }}>Search first, pick ingredient, then apply added quantity and added cost.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const ingredient = ingredients.find((x: any) => x.id === ingredientPurchaseForm.ingredientId);
              const addedQty = Number(ingredientPurchaseForm.addedQuantity || 0);
              const addedCost = Number(ingredientPurchaseForm.addedCost || 0);
              void submit(async () => {
                await apiPost("/operations/ingredients/purchase", {
                  ingredientId: ingredientPurchaseForm.ingredientId,
                  addedQuantity: addedQty,
                  addedCost
                });
                setIngredientPurchaseForm({ ingredientId: "", addedQuantity: "", addedCost: "" });
                setIngredientPurchaseSearch("");
              }, {
                title: "Confirm ingredient purchase update",
                from: {
                  ingredient: ingredient?.name || "Unknown",
                  quantityOnHand: Number(ingredient?.quantityOnHand || 0),
                  totalCost: Number(ingredient?.totalCost || 0)
                },
                to: {
                  ingredient: ingredient?.name || "Unknown",
                  quantityOnHand: Number(ingredient?.quantityOnHand || 0) + addedQty,
                  totalCost: Number(ingredient?.totalCost || 0) + addedCost
                }
              });
            }}
          >
            <input
              placeholder="Search ingredient for purchase..."
              value={ingredientPurchaseSearch}
              onChange={(e) => setIngredientPurchaseSearch(e.target.value)}
              style={{ minWidth: 280 }}
            />
            <select
              value={ingredientPurchaseForm.ingredientId}
              onChange={(e) => setIngredientPurchaseForm({ ...ingredientPurchaseForm, ingredientId: e.target.value })}
              required
            >
              <option value="">Select ingredient</option>
              {ingredients
                .filter((i: any) => i.name.toLowerCase().includes(ingredientPurchaseSearch.toLowerCase().trim()))
                .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
                .map((i: any) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
            </select>
            <input placeholder="Added qty (lb)" type="number" step="0.01" value={ingredientPurchaseForm.addedQuantity} onChange={(e) => setIngredientPurchaseForm({ ...ingredientPurchaseForm, addedQuantity: e.target.value })} required />
            <input placeholder="Added cost $" type="number" step="0.01" value={ingredientPurchaseForm.addedCost} onChange={(e) => setIngredientPurchaseForm({ ...ingredientPurchaseForm, addedCost: e.target.value })} required />
            <button type="submit">Apply purchase</button>
          </form>
          {(() => {
            const selected = ingredients.find((i: any) => i.id === ingredientPurchaseForm.ingredientId);
            if (!selected) return null;
            const addedQty = Number(ingredientPurchaseForm.addedQuantity || 0);
            const addedCost = Number(ingredientPurchaseForm.addedCost || 0);
            const nextQty = Number(selected.quantityOnHand || 0) + addedQty;
            const nextCost = Number(selected.totalCost || 0) + addedCost;
            return (
              <div style={{ margin: "8px 0 14px", fontSize: 13, color: "#374151" }}>
                <strong>{selected.name}</strong> | Qty: {Number(selected.quantityOnHand || 0).toFixed(2)} → {nextQty.toFixed(2)} | Cost:{" "}
                <SignedMoney value={selected.totalCost} /> → <SignedMoney value={nextCost} />
              </div>
            );
          })()}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(async () => {
                await apiPost("/operations/ingredients", {
                  ...ingredientForm,
                  quantityOnHand: Number(ingredientForm.quantityOnHand || 0),
                  totalCost: Number(ingredientForm.totalCost || 0),
                  percentAdded: Number(ingredientForm.percentAdded || 0),
                  chargePerPound: 0
                });
                setIngredientForm({
                  name: "",
                  category: "Meats",
                  unit: "lb",
                  quantityOnHand: "",
                  totalCost: "",
                  percentAdded: ""
                });
              });
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 0.7fr 0.8fr 0.8fr 0.8fr auto", gap: 8 }}>
              <input placeholder="Ingredient name" value={ingredientForm.name} onChange={(e) => setIngredientForm({ ...ingredientForm, name: e.target.value })} required />
              <select value={ingredientForm.category} onChange={(e) => setIngredientForm({ ...ingredientForm, category: e.target.value })}>
                <option>Meats</option>
                <option>Organs</option>
                <option>Dairy</option>
                <option>Fruits/Veggies</option>
                <option>Fats</option>
                <option>Supplements</option>
                <option>Packaging</option>
                <option>Uncategorized</option>
              </select>
              <input placeholder="Unit" value={ingredientForm.unit} onChange={(e) => setIngredientForm({ ...ingredientForm, unit: e.target.value })} required />
              <input placeholder="Qty" type="number" step="0.01" value={ingredientForm.quantityOnHand} onChange={(e) => setIngredientForm({ ...ingredientForm, quantityOnHand: e.target.value })} required />
              <input placeholder="Cost $" type="number" step="0.01" value={ingredientForm.totalCost} onChange={(e) => setIngredientForm({ ...ingredientForm, totalCost: e.target.value })} required />
              <input placeholder="% Added" type="number" step="0.01" value={ingredientForm.percentAdded} onChange={(e) => setIngredientForm({ ...ingredientForm, percentAdded: e.target.value })} />
              <button type="submit">Add to sheet</button>
            </div>
          </form>

          {Object.entries(ingredientsByCategory).map(([category, items]) => (
            <div key={category} style={{ marginTop: 14 }}>
              <h3>{category}</h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Ingredient</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Quantity (editable)</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Cost $</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Price/lb $</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Inventory left (lb)</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Update</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i: any) => (
                      <tr key={i.id}>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{i.name}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>
                          <input
                            type="number"
                            step="0.01"
                            value={ingredientEditRows[i.id]?.quantityOnHand ?? String(Number(i.quantityOnHand).toFixed(2))}
                            onChange={(e) =>
                              setIngredientEditRows((prev) => ({
                                ...prev,
                                [i.id]: {
                                  quantityOnHand: e.target.value,
                                  totalCost: prev[i.id]?.totalCost ?? String(Number(i.totalCost).toFixed(2))
                                }
                              }))
                            }
                            style={{ width: 90 }}
                          />{" "}
                          {i.unit}
                        </td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>
                          <input
                            type="number"
                            step="0.01"
                            value={ingredientEditRows[i.id]?.totalCost ?? String(Number(i.totalCost).toFixed(2))}
                            onChange={(e) =>
                              setIngredientEditRows((prev) => ({
                                ...prev,
                                [i.id]: {
                                  quantityOnHand: prev[i.id]?.quantityOnHand ?? String(Number(i.quantityOnHand).toFixed(2)),
                                  totalCost: e.target.value
                                }
                              }))
                            }
                            style={{ width: 100 }}
                          />
                        </td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>
                          <SignedMoney value={i.pricePerLb} />
                        </td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{Number(i.quantityOnHand).toFixed(2)}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>
                          <button
                            type="button"
                            onClick={() =>
                              void submit(async () => {
                                const edit = ingredientEditRows[i.id] ?? {
                                  quantityOnHand: String(Number(i.quantityOnHand).toFixed(2)),
                                  totalCost: String(Number(i.totalCost).toFixed(2))
                                };
                                await apiPost("/operations/ingredients/update-core", {
                                  ingredientId: i.id,
                                  quantityOnHand: Number(edit.quantityOnHand || 0),
                                  totalCost: Number(edit.totalCost || 0),
                                  chargePerPound: Number(i.chargePerPound || 0)
                                });
                              }, {
                                title: "Confirm ingredient update",
                                from: {
                                  ingredient: i.name,
                                  quantityOnHand: Number(i.quantityOnHand || 0),
                                  totalCost: Number(i.totalCost || 0),
                                  pricePerLb: Number(i.pricePerLb || 0)
                                },
                                to: {
                                  ingredient: i.name,
                                  quantityOnHand: Number((ingredientEditRows[i.id]?.quantityOnHand ?? i.quantityOnHand) || 0),
                                  totalCost: Number((ingredientEditRows[i.id]?.totalCost ?? i.totalCost) || 0),
                                  pricePerLb:
                                    Number((ingredientEditRows[i.id]?.quantityOnHand ?? i.quantityOnHand) || 0) > 0
                                      ? Number((ingredientEditRows[i.id]?.totalCost ?? i.totalCost) || 0) /
                                        Number((ingredientEditRows[i.id]?.quantityOnHand ?? i.quantityOnHand) || 1)
                                      : 0
                                }
                              })
                            }
                          >
                            Save
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      )}

      {activeTab === "Inventory" && (
        <section>
          <h2>Inventory Lots</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(async () => {
                await apiPost("/operations/inventory", { ...inventoryForm, quantityLbs: Number(inventoryForm.quantityLbs), unitCost: Number(inventoryForm.unitCost) });
                setInventoryForm({ ingredient: "", quantityLbs: "", unitCost: "", receivedAt: new Date().toISOString().slice(0, 10) });
              });
            }}
          >
            <input placeholder="Ingredient" value={inventoryForm.ingredient} onChange={(e) => setInventoryForm({ ...inventoryForm, ingredient: e.target.value })} required />
            <input placeholder="Quantity lbs" type="number" step="0.01" value={inventoryForm.quantityLbs} onChange={(e) => setInventoryForm({ ...inventoryForm, quantityLbs: e.target.value })} required />
            <input placeholder="Unit cost" type="number" step="0.01" value={inventoryForm.unitCost} onChange={(e) => setInventoryForm({ ...inventoryForm, unitCost: e.target.value })} required />
            <input type="date" value={inventoryForm.receivedAt} onChange={(e) => setInventoryForm({ ...inventoryForm, receivedAt: e.target.value })} required />
            <button type="submit">Add Lot</button>
          </form>
          <ul>
            {rows.inventory.map((lot: any) => (
              <li key={lot.id}>
                {lot.ingredient}: {Number(lot.quantityLbs).toFixed(2)} lbs @ <SignedMoney value={lot.unitCost} />
              </li>
        ))}
      </ul>
        </section>
      )}

      {activeTab === "Submit Order" && (
        <section>
          <h2>Submit Order</h2>
          <p style={{ marginTop: 0, maxWidth: 720, color: "#395946" }}>
            Enter customer details, choose the recipe (what they want), and quantity. Pricing matches <strong>Pending Orders</strong>: net sale + NJ 6.625% tax = total charged; COGS and profit update live.
            Optional <strong>coupon / co-op code</strong>: each code can combine <strong>% or $ off</strong> pre-tax (lowers what the customer pays) and <strong>% or $ kickback</strong> on pre-tax sales (tracked on <strong>Coupons & Co-ops</strong>). The &quot;type&quot; is mainly for labels.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitOrderPaymentMethodError("");
              if (!submitOrderForm.paymentMethod.trim()) {
                setSubmitOrderPaymentMethodError("Choose a payment method before submitting the order.");
                return;
              }
              void submit(
                async () => {
                  const name = submitOrderForm.name.trim();
                  if (!name) throw new Error("Customer name is required.");
                  if (submitOrderItemRows.length === 0) throw new Error("Add at least one product item to the order.");

                  const existing = findCustomerForOrder(customers, submitOrderForm.phone, submitOrderForm.email);
                  let customerId: string;
                  if (existing) {
                    customerId = existing.id;
                    await apiPut(`/operations/customers/${customerId}`, {
                      name,
                      email: submitOrderForm.email.trim() || undefined,
                      phone: submitOrderForm.phone.trim() || undefined
                    });
                  } else {
                    const created: any = await apiPost("/operations/customers", {
                      name,
                      email: submitOrderForm.email.trim() || undefined,
                      phone: submitOrderForm.phone.trim() || undefined
                    });
                    customerId = created.id;
                  }

                  const noteParts: string[] = [];
                  if (submitOrderForm.address.trim()) {
                    noteParts.push(`Address:\n${submitOrderForm.address.trim()}`);
                  }
                  if (submitOrderForm.notes.trim()) {
                    noteParts.push(`Customer request / what they want:\n${submitOrderForm.notes.trim()}`);
                  }
                  const notes = noteParts.join("\n\n");

                  await apiPost("/operations/orders", {
                    customerId,
                    quantityLbs: Number(submitOrderCalc.lbs || 0),
                    subtotal: Number(submitOrderPromoPreview.subtotalInclTax.toFixed(2)),
                    cogs: Number(submitOrderPromoPreview.cogs.toFixed(2)),
                    status: "NEW",
                    notes,
                    paymentMethod: submitOrderForm.paymentMethod.trim(),
                    promoCode: submitOrderForm.promoCode.trim() || undefined,
                    items: submitOrderItemRows.map((row) => ({ recipeId: row.recipeId, quantityLbs: Number(row.quantityLbs) }))
                  });
                  setSubmitOrderForm({
                    name: "",
                    phone: "",
                    email: "",
                    address: "",
                    recipeId: "",
                    quantityLbs: "",
                    notes: "",
                    paymentMethod: "",
                    promoCode: ""
                  });
                  setSubmitOrderItems([]);
                  setSubmitOrderPromoCheck(null);
                },
                {
                  title: "Confirm new order",
                  from: "(not saved yet)",
                  to: {
                    customer: submitOrderForm.name.trim(),
                    items: submitOrderItemRows.map((x) => `${x.recipe.name} (${x.quantityLbs})`),
                    total: submitOrderPromoPreview.subtotalInclTax
                  }
                }
              );
            }}
            style={{
              display: "grid",
              gap: 12,
              maxWidth: 640,
              padding: 16,
              border: "1px solid #cfe0d4",
              borderRadius: 12,
              background: "#fafdfb"
            }}
          >
            <h3 style={{ margin: 0 }}>Customer</h3>
            <input
              placeholder="Full name *"
              value={submitOrderForm.name}
              onChange={(e) => setSubmitOrderForm({ ...submitOrderForm, name: e.target.value })}
              required
            />
            <input
              placeholder="Phone"
              type="tel"
              value={submitOrderForm.phone}
              onChange={(e) => setSubmitOrderForm({ ...submitOrderForm, phone: e.target.value })}
              autoComplete="tel"
            />
            <input
              placeholder="Email"
              type="email"
              value={submitOrderForm.email}
              onChange={(e) => setSubmitOrderForm({ ...submitOrderForm, email: e.target.value })}
              autoComplete="email"
            />
            <textarea
              placeholder="Street address (delivery / mailing) — saved on the order notes"
              value={submitOrderForm.address}
              onChange={(e) => setSubmitOrderForm({ ...submitOrderForm, address: e.target.value })}
              rows={3}
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
            <h3 style={{ margin: 0 }}>Order</h3>
            <select value={submitOrderForm.recipeId} onChange={(e) => setSubmitOrderForm({ ...submitOrderForm, recipeId: e.target.value })}>
              <option value="">What they want (select recipe) *</option>
              {recipeOptionsSorted.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.chargeUnit === "bag" ? " (per bag)" : " (per lb)"}
                </option>
              ))}
            </select>
            <input
              placeholder={selectedSubmitOrderRecipe?.chargeUnit === "bag" ? "Quantity (bags)" : "Quantity (lbs)"}
              type="number"
              step={selectedSubmitOrderRecipe?.chargeUnit === "bag" ? "1" : "0.01"}
              min="0"
              value={submitOrderForm.quantityLbs}
              onChange={(e) => setSubmitOrderForm({ ...submitOrderForm, quantityLbs: e.target.value })}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  const rid = String(submitOrderForm.recipeId || "").trim();
                  const qty = Number(submitOrderForm.quantityLbs || 0);
                  if (!rid || !(qty > 0)) return;
                  setSubmitOrderItems((prev) => {
                    const idx = prev.findIndex((x) => x.recipeId === rid);
                    if (idx >= 0) {
                      const next = [...prev];
                      next[idx] = { ...next[idx], quantityLbs: Number((next[idx].quantityLbs + qty).toFixed(4)) };
                      return next;
                    }
                    return [...prev, { recipeId: rid, quantityLbs: qty }];
                  });
                  setSubmitOrderForm({ ...submitOrderForm, recipeId: "", quantityLbs: "" });
                }}
              >
                Add item
              </button>
              <span style={{ fontSize: 12, color: "#64748b" }}>Add each recipe/quantity, then submit once.</span>
            </div>
            {submitOrderItemRows.length > 0 ? (
              <div style={{ border: "1px solid #d4e4d9", borderRadius: 10, padding: 10, background: "#f8fffa" }}>
                <strong>Items in this order</strong>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {submitOrderItemRows.map((row) => (
                    <li key={row.recipeId} style={{ marginBottom: 6 }}>
                      {row.recipe.name} - {Number(row.quantityLbs || 0)} {row.recipe.chargeUnit === "bag" ? "bag(s)" : "lb"}
                      <button
                        type="button"
                        style={{ marginLeft: 8 }}
                        onClick={() => setSubmitOrderItems((prev) => prev.filter((x) => x.recipeId !== row.recipeId))}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "#b45309" }}>No items added yet.</div>
            )}
            <textarea
              placeholder="Extra details: pickup time, mix, special instructions…"
              value={submitOrderForm.notes}
              onChange={(e) => setSubmitOrderForm({ ...submitOrderForm, notes: e.target.value })}
              rows={2}
              style={{ resize: "vertical", fontFamily: "inherit" }}
            />
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
              Payment method <span style={{ color: "#b91c1c" }}>*</span>
              <select
                value={submitOrderForm.paymentMethod}
                onChange={(e) => {
                  setSubmitOrderPaymentMethodError("");
                  setSubmitOrderForm({ ...submitOrderForm, paymentMethod: e.target.value });
                }}
                style={{
                  borderColor: submitOrderPaymentMethodError ? "#dc2626" : undefined,
                  outline: submitOrderPaymentMethodError ? "2px solid rgba(220, 38, 38, 0.35)" : undefined
                }}
              >
                <option value="">Select payment method…</option>
                {paymentMethodOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            {submitOrderPaymentMethodError ? (
              <div style={{ fontSize: 13, fontWeight: 700, color: "#b91c1c", marginTop: -4 }}>{submitOrderPaymentMethodError}</div>
            ) : null}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="Coupon or co-op code (optional)"
                value={submitOrderForm.promoCode}
                onChange={(e) => {
                  setSubmitOrderForm({ ...submitOrderForm, promoCode: e.target.value });
                  setSubmitOrderPromoCheck(null);
                }}
                autoCapitalize="characters"
                style={{ maxWidth: 320 }}
              />
              <button
                type="button"
                onClick={() => {
                  const code = submitOrderForm.promoCode.trim().toUpperCase();
                  if (!code) {
                    setSubmitOrderPromoCheck({ kind: "error", text: "Enter a coupon or co-op code first." });
                    return;
                  }
                  const promo = promoCodes.find((x: any) => x.active && String(x.code || "").toUpperCase() === code);
                  if (!promo) {
                    setSubmitOrderPromoCheck({ kind: "error", text: `No active coupon/co-op found for "${code}".` });
                    return;
                  }
                  const bits: string[] = [];
                  if (Number(promo.discountPercent || 0) > 0 || Number(promo.discountFixed || 0) > 0) {
                    bits.push("customer discount");
                  }
                  if (Number(promo.kickbackPercent || 0) > 0 || Number(promo.kickbackFixed || 0) > 0) {
                    bits.push("kickback tracking");
                  }
                  setSubmitOrderPromoCheck({
                    kind: "ok",
                    text: `Code ${promo.code} (${promo.label}) — ${bits.length ? bits.join(" + ") : "configured rules"} will apply at submit.`
                  });
                }}
              >
                Apply Coupon / Co-op
              </button>
            </div>
            {submitOrderPromoCheck ? (
              <div
                style={{
                  fontSize: 12,
                  color: submitOrderPromoCheck.kind === "ok" ? "#166534" : "#b45309"
                }}
              >
                {submitOrderPromoCheck.text}
              </div>
            ) : null}
            <div
              style={{
                border: "1px solid #d4e4d9",
                borderRadius: 10,
                padding: 12,
                background: "#f0fdf4",
                lineHeight: 1.7
              }}
            >
              <strong>Totals (live)</strong>
              {submitOrderForm.promoCode.trim() && !submitOrderPromoPreview.matched ? (
                <div style={{ color: "#b45309", fontSize: 13, marginBottom: 6 }}>
                  No active code matches &quot;{submitOrderForm.promoCode.trim()}&quot; — fix the code or leave blank (order will fail if you submit a bad code).
                </div>
              ) : null}
              {submitOrderPromoPreview.matched && submitOrderPromoPreview.discountPreTax > 0 ? (
                <div style={{ fontSize: 13, color: "#166534", marginBottom: 6 }}>
                  <strong>{submitOrderPromoPreview.matched.code}</strong> — pre-tax discount{" "}
                  <SignedMoney value={submitOrderPromoPreview.discountPreTax} />
                </div>
              ) : null}
              {submitOrderPromoPreview.matched && submitOrderPromoPreview.coopKickback > 0 ? (
                <div style={{ fontSize: 13, color: "#1e40af", marginBottom: 6 }}>
                  <strong>{submitOrderPromoPreview.matched.code}</strong> — est. kickback owed (pre-tax base){" "}
                  <SignedMoney value={submitOrderPromoPreview.coopKickback} />
                </div>
              ) : null}
              <div>
                Net sale (before tax): <SignedMoney value={submitOrderPromoPreview.netRevenue} />
              </div>
              <div>
                NJ sales tax (6.625% of net): <SignedMoney value={submitOrderPromoPreview.salesTax} />
              </div>
              <div style={{ fontWeight: 700 }}>
                Customer pays (total): <SignedMoney value={submitOrderPromoPreview.subtotalInclTax} />
              </div>
              <div>
                COGS: <SignedMoney value={submitOrderPromoPreview.cogs} />
              </div>
              {submitOrderCalc.lbs > 0 ? (
                <div style={{ fontSize: 13, color: "#4d6657" }}>
                  Implied net $ / lb: <SignedMoney value={submitOrderPromoPreview.netRevenue / submitOrderCalc.lbs} />
                </div>
              ) : null}
            </div>
            <button type="submit" style={{ justifySelf: "start", padding: "10px 18px", fontWeight: 700 }}>
              Submit order
            </button>
            <p style={{ margin: 0, fontSize: 12, color: "#5a6b5f" }}>
              If phone or email matches an existing customer, that record is reused and updated. The order appears under <strong>Pending Orders</strong> (status NEW).
            </p>
          </form>
        </section>
      )}

      {activeTab === "Pending Orders" && (
        <section>
          <h2>Pending Orders</h2>
          <div style={{ marginTop: 14, border: "1px solid #cfe0d4", borderRadius: 10, padding: 10, background: "#fff" }}>
            <h3 style={{ marginTop: 0 }}>Pending Orders (Oldest to Newest)</h3>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: "#395946" }}>
              <strong>Auto invoices:</strong> every pending order gets an invoice + <strong>saved PDF</strong> as soon as it&apos;s created (Submit Order), and
              totals stay in sync when you edit the order (NJ 6.625% tax). Opening this tab runs a quick sync for anything missing. Invoice numbers use{" "}
              <strong>order date + customer phone</strong> (e.g. <code style={{ background: "#d1fae5", padding: "2px 6px", borderRadius: 4 }}>2025-03-23-7325551212</code>
              ); same day + same phone adds <code style={{ background: "#d1fae5", padding: "2px 6px", borderRadius: 4 }}>-2</code>, <code style={{ background: "#d1fae5", padding: "2px 6px", borderRadius: 4 }}>-3</code>, etc. No phone on file uses{" "}
              <code style={{ background: "#d1fae5", padding: "2px 6px", borderRadius: 4 }}>nophone</code>. Use <strong>Preview PDF</strong> to open.
            </p>
            <p style={{ marginTop: 0 }}>
              Orders: {pendingSummary.orders} | Total lbs: {pendingSummary.lbs.toFixed(0)} | Total (tax incl): <SignedMoney value={pendingSummary.revenue} /> | Net
              sales: <SignedMoney value={pendingSummary.netRevenue} /> | NJ tax: <SignedMoney value={pendingSummary.salesTax} /> | Total Profit:{" "}
              <SignedMoney value={pendingSummary.profit} /> | Profit/lb:{" "}
              <SignedMoney value={pendingSummary.lbs > 0 ? pendingSummary.profit / pendingSummary.lbs : 0} />
            </p>
            {pendingOrders.length === 0 ? (
              <p style={{ margin: 0 }}>No pending orders.</p>
            ) : (
              <>
                <div
                  style={{
                    marginBottom: 14,
                    padding: "12px 14px",
                    border: "1px solid #bfdbfe",
                    borderRadius: 12,
                    background: "#f0f9ff",
                    maxWidth: 920
                  }}
                >
                  <h3 style={{ marginTop: 0, marginBottom: 8, color: "#1e3a8a", fontSize: 17 }}>JR Workers — pick-ups &amp; paid</h3>
                  <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
                    All current <strong>pending</strong> orders (NEW / CONFIRMED), oldest first. Use search to narrow by name, phone (digits), email, order id, invoice #,
                    notes, product lines, status, or payment status. Change a note or payment method on any card, then <strong>Save changes</strong> on that card, or use{" "}
                    <strong>Save all</strong> above to write every unsaved card at once. Mark paid / picked up below when ready.
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                    <input
                      type="search"
                      placeholder="Search pending orders…"
                      value={jrWorkerPickupsSearch}
                      onChange={(e) => setJrWorkerPickupsSearch(e.target.value)}
                      aria-label="Filter pending orders for JR Workers"
                      style={{
                        minWidth: 280,
                        flex: "1 1 240px",
                        padding: "10px 12px",
                        borderRadius: 10,
                        border: "1px solid #93c5fd",
                        fontSize: 15
                      }}
                    />
                    <span style={{ fontSize: 13, color: "#64748b", whiteSpace: "nowrap" }}>
                      Showing <strong>{pendingOrdersForJrPickups.length}</strong> of {pendingOrders.length} pending
                      {jrWorkerPickupsSearch.trim() ? (
                        <button
                          type="button"
                          onClick={() => setJrWorkerPickupsSearch("")}
                          style={{
                            marginLeft: 10,
                            padding: "4px 10px",
                            borderRadius: 8,
                            border: "1px solid #94a3b8",
                            background: "#fff",
                            cursor: "pointer",
                            fontSize: 12
                          }}
                        >
                          Clear search
                        </button>
                      ) : null}
                    </span>
                  </div>
                  {dirtyJrWorkerPickups.length > 0 ? (
                    <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                      <button
                        type="button"
                        onClick={() =>
                          void submit(async () => {
                            for (const row of dirtyJrWorkerPickups) {
                              const d = pendingOrderDraftDiff(row, orderNoteById, pendingPaymentMethodByOrder);
                              await apiPut(`/operations/orders/${row.id}`, {
                                notes: d.draftNote,
                                paymentMethod: d.draftPm
                              });
                            }
                            setOrderNoteById((prev) => {
                              const next = { ...prev };
                              for (const row of dirtyJrWorkerPickups) delete next[row.id];
                              return next;
                            });
                            setPendingPaymentMethodByOrder((prev) => {
                              const next = { ...prev };
                              for (const row of dirtyJrWorkerPickups) delete next[row.id];
                              return next;
                            });
                          }, {
                            title: "Save all order notes and payment methods?",
                            from: {
                              Summary: `You have ${dirtyJrWorkerPickups.length} order card(s) with edits not saved to the sheet yet.`,
                              Orders: dirtyJrWorkerPickups.map((row: any) => {
                                const d = pendingOrderDraftDiff(row, orderNoteById, pendingPaymentMethodByOrder);
                                return `${orderCustomerName(row) || row.id}: note “${d.savedNote || "—"}” · payment “${d.savedPm || "—"}”`;
                              })
                            },
                            to: {
                              Summary: "The sheet will store the new note and payment method for each order listed below.",
                              Orders: dirtyJrWorkerPickups.map((row: any) => {
                                const d = pendingOrderDraftDiff(row, orderNoteById, pendingPaymentMethodByOrder);
                                return `${orderCustomerName(row) || row.id}: note “${d.draftNote || "—"}” · payment “${d.draftPm || "—"}”`;
                              })
                            },
                            queueContext: {
                              customerName: "Save all (unsaved cards)",
                              customerPhone: `${dirtyJrWorkerPickups.length} order(s)`
                            }
                          })
                        }
                        style={{
                          padding: "10px 18px",
                          borderRadius: 10,
                          border: "2px solid #166534",
                          background: "#fde68a",
                          color: "#78350f",
                          fontWeight: 800,
                          cursor: "pointer",
                          fontSize: 15
                        }}
                      >
                        Save all ({dirtyJrWorkerPickups.length})
                      </button>
                      <span style={{ fontSize: 13, color: "#475569", maxWidth: 520, lineHeight: 1.45 }}>
                        Saves every <strong>unsaved</strong> note and payment-method choice on the cards below in one step.
                      </span>
                    </div>
                  ) : null}
                </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {pendingOrdersForJrPickups.length === 0 ? (
                  <li style={{ padding: 12, background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10 }}>
                    No orders match <strong>{jrWorkerPickupsSearch.trim() || "this filter"}</strong>.{" "}
                    <button type="button" onClick={() => setJrWorkerPickupsSearch("")} style={{ textDecoration: "underline", background: "none", border: 0, cursor: "pointer" }}>
                      Clear search
                    </button>{" "}
                    to show all {pendingOrders.length} pending.
                  </li>
                ) : null}
                {pendingOrdersForJrPickups.map((o: any) => {
                  const cardDraft = pendingOrderDraftDiff(o, orderNoteById, pendingPaymentMethodByOrder);
                  const sheetBusyThis = isOrderSheetBusy(String(o.id));
                  return (
                  <li
                    key={o.id}
                    style={{
                      position: "relative",
                      marginBottom: 12,
                      background: pendingOrderRowColor(o),
                      border: cardDraft.dirty ? "2px solid #f59e0b" : "1px solid #cfe0d4",
                      borderRadius: 12,
                      padding: 14
                    }}
                  >
                    {sheetBusyThis ? (
                      <div
                        role="status"
                        style={{
                          position: "absolute",
                          inset: 0,
                          zIndex: 8,
                          borderRadius: 12,
                          background: "rgba(255,255,255,0.85)",
                          backdropFilter: "blur(3px)",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 16,
                          textAlign: "center",
                          fontWeight: 800,
                          color: "#1d4ed8",
                          fontSize: 14,
                          lineHeight: 1.45,
                          pointerEvents: "auto"
                        }}
                      >
                        <span style={{ fontSize: 15 }}>Sheet action in progress for this customer</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#475569", marginTop: 6, maxWidth: 320 }}>
                          This order is waiting in line or sending to Google. You can use other cards meanwhile.
                        </span>
                      </div>
                    ) : null}
                    {(() => {
                      const m = orderMetrics(o);
                      const recipe = orderRecipeLabel(o);
                      const itemRows = orderItemList(o);
                      const name = orderCustomerName(o) || "—";
                      const phone = orderCustomerPhone(o) || "—";
                      const email = orderCustomerEmail(o);
                      const ordered = new Date(o.createdAt).toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        year: "numeric"
                      });
                      return (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
                            gap: 18,
                            alignItems: "start"
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "flex-start",
                              gap: 8,
                              textAlign: "left",
                              borderLeft: "4px solid #166534",
                              paddingLeft: 14,
                              minWidth: 0
                            }}
                          >
                            <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", lineHeight: 1.2, width: "100%" }}>{name}</div>
                            <div style={{ fontSize: 15, fontWeight: 700, color: "#1e293b", letterSpacing: "0.02em" }}>{phone}</div>
                            {email ? (
                              <div style={{ fontSize: 13, color: "#475569", wordBreak: "break-word", width: "100%" }}>{email}</div>
                            ) : null}
                            <div style={{ fontSize: 15, fontWeight: 700, color: "#14532d" }}>{recipe}</div>
                            <div style={{ fontSize: 17, fontWeight: 800, color: "#0f172a" }}>{m.lbs.toFixed(0)} lb</div>
                            {itemRows.length > 0 ? (
                              <div style={{ width: "100%", marginTop: 4 }}>
                                {itemRows.map((r, idx) => (
                                  <div
                                    key={`${o.id}-item-${idx}`}
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: "1.4fr auto auto auto",
                                      gap: 8,
                                      fontSize: 12,
                                      padding: "3px 0",
                                      borderBottom: "1px dashed #e2e8f0"
                                    }}
                                  >
                                    <span style={{ color: "#0f172a" }}>{r.item}</span>
                                    <span style={{ textAlign: "right", color: "#334155" }}>
                                      {r.qty.toFixed(0)} {r.unit}
                                    </span>
                                    <span style={{ textAlign: "right", color: "#334155" }}>
                                      <SignedMoney value={r.amountPerLb} />/lb
                                    </span>
                                    <span style={{ textAlign: "right", color: "#0f172a" }}>
                                      <SignedMoney value={r.lineTotal} />
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div style={{ width: "100%", maxWidth: 320, marginLeft: "auto" }}>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10, alignItems: "center", justifyContent: "flex-end" }}>
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 800,
                                  textTransform: "uppercase",
                                  letterSpacing: "0.06em",
                                  padding: "5px 12px",
                                  borderRadius: 999,
                                  background: o.status === "CONFIRMED" ? "#dbeafe" : "#d1fae5",
                                  color: o.status === "CONFIRMED" ? "#1e40af" : "#14532d",
                                  border: "1px solid #9ec1ac"
                                }}
                              >
                                {o.status}
                              </span>
                              <span style={{ fontSize: 13, color: "#64748b", textAlign: "right" }}>{ordered}</span>
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "1fr auto",
                                columnGap: 14,
                                rowGap: 6,
                                fontSize: 13,
                                width: "100%"
                              }}
                            >
                              <span style={{ color: "#64748b", textAlign: "right" }}>Total (incl tax)</span>
                              <span style={{ fontWeight: 800, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                <SignedMoney value={m.subtotal} />
                              </span>
                              <span style={{ color: "#64748b", textAlign: "right" }}>Net</span>
                              <span style={{ fontWeight: 600, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                <SignedMoney value={m.netRevenue} />
                              </span>
                              <span style={{ color: "#64748b", textAlign: "right" }}>NJ tax</span>
                              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                <SignedMoney value={m.salesTax} />
                              </span>
                              <span style={{ color: "#64748b", textAlign: "right" }}>Price / lb</span>
                              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                <SignedMoney value={m.pricePerLb} />
                              </span>
                              <span style={{ color: "#64748b", textAlign: "right" }}>Profit</span>
                              <span style={{ fontWeight: 800, textAlign: "right", color: "#14532d", fontVariantNumeric: "tabular-nums" }}>
                                <SignedMoney value={m.profitTotal} />
                              </span>
                              <span style={{ color: "#64748b", textAlign: "right" }}>Profit / lb</span>
                              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                <SignedMoney value={m.profitPerLb} />
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid #e2e8f0" }}>
                      <button
                        type="button"
                        onClick={() => {
                          const m = orderMetrics(o);
                          let parsedItems: Array<{ recipeId: string; quantityLbs: string }> = parseOrderItemLines(o)
                            .map((x) => ({ recipeId: String(x.recipeId || ""), quantityLbs: String(Number(x.quantityLbs || 0) || "") }))
                            .filter((x) => x.recipeId && Number(x.quantityLbs || 0) > 0);
                          if (parsedItems.length === 0) {
                            parsedItems = [{ recipeId: String(o.recipeId || ""), quantityLbs: String(m.lbs || "") }].filter(
                              (x) => x.recipeId && Number(x.quantityLbs || 0) > 0
                            );
                          }
                          if (parsedItems.length === 0) parsedItems = [{ recipeId: "", quantityLbs: "" }];
                          setEditingOrderId(o.id);
                          setOrderEditForm({
                            customerName: orderCustomerName(o),
                            customerEmail: orderCustomerEmail(o),
                            customerPhone: orderCustomerPhone(o)
                          });
                          setOrderEditItems(parsedItems);
                        }}
                      >
                        Edit Order
                      </button>
                      <select
                        value={pendingPaymentMethodByOrder[o.id] ?? o.paymentMethod ?? ""}
                        onChange={(e) => {
                          setPendingOrderActionErrorByOrder((prev) => {
                            const n = { ...prev };
                            delete n[o.id];
                            return n;
                          });
                          setPendingPaymentMethodByOrder((prev) => ({ ...prev, [o.id]: e.target.value }));
                        }}
                        aria-invalid={Boolean(pendingOrderActionErrorByOrder[o.id])}
                        style={{
                          borderColor: pendingOrderActionErrorByOrder[o.id] ? "#dc2626" : undefined,
                          outline: pendingOrderActionErrorByOrder[o.id] ? "2px solid rgba(220, 38, 38, 0.35)" : undefined
                        }}
                      >
                        <option value="">Select payment method…</option>
                        {paymentMethodOptions.map((pm) => (
                          <option key={pm} value={pm}>
                            {pm}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          const method = resolvedPendingPaymentMethod(o, pendingPaymentMethodByOrder);
                          if (!isPendingOrderPaid(o) && !method) {
                            setPendingOrderActionErrorByOrder((prev) => ({
                              ...prev,
                              [o.id]: "Select a payment method before marking paid (or save one on this card first)."
                            }));
                            return;
                          }
                          setPendingOrderActionErrorByOrder((prev) => {
                            const n = { ...prev };
                            delete n[o.id];
                            return n;
                          });
                          const methodForApi = method || String(o.paymentMethod || "").trim() || "Unknown";
                          void submit(async () => {
                            await apiPut(`/operations/orders/${o.id}/progress`, {
                              paid: true,
                              paymentMethod: methodForApi
                            });
                          }, {
                            title: "Mark this order as paid?",
                            from: {
                              Customer: orderCustomerName(o),
                              "Already marked paid": Boolean(o.paidAt) ? "Yes" : "No",
                              "Payment method": o.paymentMethod || "(not set on sheet)"
                            },
                            to: {
                              Customer: orderCustomerName(o),
                              "Marked paid": "Yes",
                              "Payment method": methodForApi
                            },
                            queueContext: pendingOrderQueueContext(o)
                          });
                        }}
                      >
                        Mark Paid
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const method = resolvedPendingPaymentMethod(o, pendingPaymentMethodByOrder);
                          if (!isPendingOrderPaid(o) && !method) {
                            setPendingOrderActionErrorByOrder((prev) => ({
                              ...prev,
                              [o.id]: "Select a payment method — required when the order is not paid yet."
                            }));
                            return;
                          }
                          setPendingOrderActionErrorByOrder((prev) => {
                            const n = { ...prev };
                            delete n[o.id];
                            return n;
                          });
                          const methodForApi = method || String(o.paymentMethod || "").trim() || "Unknown";
                          void submit(async () => {
                            await apiPut(`/operations/orders/${o.id}/progress`, {
                              paid: true,
                              pickedUp: true,
                              paymentMethod: methodForApi
                            });
                          }, {
                            title: "Record pickup and full payment together?",
                            from: {
                              Customer: orderCustomerName(o),
                              "Marked paid": Boolean(o.paidAt) ? "Yes" : "No",
                              PickedUp: Boolean(o.pickedUpAt) ? "Yes" : "No",
                              "Payment method": o.paymentMethod || "(not set on sheet)"
                            },
                            to: {
                              Customer: orderCustomerName(o),
                              "Marked paid": "Yes",
                              PickedUp: "Yes (moves to archive)",
                              "Payment method": methodForApi
                            },
                            queueContext: pendingOrderQueueContext(o)
                          });
                        }}
                      >
                        Up/Paid
                      </button>
                      <input
                        placeholder="Partial amount"
                        type="number"
                        step="0.01"
                        min="0"
                        value={partialAmountByOrder[o.id] ?? ""}
                        onChange={(e) => setPartialAmountByOrder((prev) => ({ ...prev, [o.id]: e.target.value }))}
                        style={{ width: 130 }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const amount = Number(partialAmountByOrder[o.id] || 0);
                          const method = resolvedPendingPaymentMethod(o, pendingPaymentMethodByOrder);
                          if (!(amount > 0)) {
                            setPendingOrderActionErrorByOrder((prev) => ({
                              ...prev,
                              [o.id]: "Enter a partial amount greater than zero."
                            }));
                            return;
                          }
                          if (!method) {
                            setPendingOrderActionErrorByOrder((prev) => ({
                              ...prev,
                              [o.id]: "Select a payment method before applying a partial payment."
                            }));
                            return;
                          }
                          setPendingOrderActionErrorByOrder((prev) => {
                            const n = { ...prev };
                            delete n[o.id];
                            return n;
                          });
                          void submit(async () => {
                            await apiPut(`/operations/orders/${o.id}/partial-payment`, {
                              amount,
                              paymentMethod: method
                            });
                            setPartialAmountByOrder((prev) => ({ ...prev, [o.id]: "" }));
                          }, {
                            title: "Apply partial payment?",
                            from: {
                              Customer: orderCustomerName(o),
                              "Payment status": String(o.paymentStatus || "UNPAID").toUpperCase()
                            },
                            to: {
                              Customer: orderCustomerName(o),
                              Amount: fmtMoney(Number(partialAmountByOrder[o.id] || 0)),
                              "Payment method": method
                            },
                            queueContext: pendingOrderQueueContext(o)
                          });
                        }}
                      >
                        Apply Partial
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void submit(async () => {
                            await apiPut(`/operations/orders/${o.id}/progress`, { pickedUp: true });
                          }, {
                            title: "Mark picked up (move to archive)?",
                            from: {
                              Customer: orderCustomerName(o),
                              "Already picked up": Boolean(o.pickedUpAt) ? "Yes" : "No"
                            },
                            to: {
                              Customer: orderCustomerName(o),
                              PickedUp: "Yes (order leaves pending)"
                            },
                            queueContext: pendingOrderQueueContext(o)
                          })
                        }
                      >
                        Picked Up
                      </button>
                      <span style={{ fontSize: 12 }}>
                        Paid at: {o.paidAt ? new Date(o.paidAt).toLocaleString() : "Not paid"} | Picked up at: {o.pickedUpAt ? new Date(o.pickedUpAt).toLocaleString() : "Not picked up"}
                      </span>
                      <span style={{ fontSize: 12 }}>
                        Paid amount: <SignedMoney value={Number(o.amountPaid || 0)} /> | Remaining: <SignedMoney value={Number(o.balanceDue || 0)} /> | Status:{" "}
                        {String(o.paymentStatus || "UNPAID").toUpperCase()}
                      </span>
                      {pendingOrderActionErrorByOrder[o.id] ? (
                        <div
                          role="alert"
                          style={{
                            width: "100%",
                            flexBasis: "100%",
                            fontSize: 13,
                            fontWeight: 700,
                            color: "#b91c1c",
                            marginTop: 2,
                            padding: "8px 10px",
                            borderRadius: 8,
                            background: "#fef2f2",
                            border: "1px solid #fecaca"
                          }}
                        >
                          {pendingOrderActionErrorByOrder[o.id]}
                        </div>
                      ) : null}
                    </div>
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {cardDraft.dirty ? (
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 800,
                            color: "#b45309",
                            padding: "4px 10px",
                            borderRadius: 8,
                            background: "#fffbeb",
                            border: "1px solid #fcd34d"
                          }}
                        >
                          Unsaved note or payment method
                        </span>
                      ) : null}
                      <input
                        placeholder="Note for this order"
                        value={orderNoteById[o.id] ?? o.notes ?? ""}
                        onChange={(e) => setOrderNoteById((prev) => ({ ...prev, [o.id]: e.target.value }))}
                        style={{ minWidth: 280, flex: "1 1 200px" }}
                      />
                      <button
                        type="button"
                        disabled={!cardDraft.dirty}
                        onClick={() => {
                          const d = pendingOrderDraftDiff(o, orderNoteById, pendingPaymentMethodByOrder);
                          if (!d.dirty) return;
                          void submit(
                            async () => {
                              await apiPut(`/operations/orders/${o.id}`, {
                                notes: d.draftNote,
                                paymentMethod: d.draftPm
                              });
                              setOrderNoteById((prev) => {
                                const next = { ...prev };
                                delete next[o.id];
                                return next;
                              });
                              setPendingPaymentMethodByOrder((prev) => {
                                const next = { ...prev };
                                delete next[o.id];
                                return next;
                              });
                            },
                            {
                              title: "Save note and payment method for this order?",
                              from: {
                                Customer: orderCustomerName(o),
                                Note: d.savedNote || "(none)",
                                "Payment method (used when you mark paid)": d.savedPm || "(not set)"
                              },
                              to: {
                                Customer: orderCustomerName(o),
                                Note: d.draftNote || "(none)",
                                "Payment method (used when you mark paid)": d.draftPm || "(not set)"
                              },
                              queueContext: pendingOrderQueueContext(o)
                            }
                          );
                        }}
                        style={{
                          padding: "8px 16px",
                          fontWeight: 700,
                          borderRadius: 10,
                          border: cardDraft.dirty ? "2px solid #166534" : "1px solid #cbd5e1",
                          background: cardDraft.dirty ? "#86efac" : "#f1f5f9",
                          color: cardDraft.dirty ? "#14532d" : "#94a3b8",
                          cursor: cardDraft.dirty ? "pointer" : "not-allowed"
                        }}
                      >
                        Save changes
                      </button>
                    </div>
                    {o.notes ? <div style={{ marginTop: 4, fontSize: 12, color: "#1f4d37" }}>Note: {o.notes}</div> : null}
                    {o.promoCode || o.promoCodeEntered ? (
                      <div style={{ marginTop: 6, fontSize: 12, color: "#1e3a5f" }}>
                        Promo:{" "}
                        {o.promoCode ? (
                          <>
                            <strong>{o.promoCode.code}</strong> — {o.promoCode.label} ({o.promoCode.kind === "COOP" ? "Co-op" : "Coupon"})
                            {Number(o.coOpKickbackOwed || 0) > 0 ? (
                              <>
                                {" "}
                                · Kickback owed: <SignedMoney value={o.coOpKickbackOwed} />
                              </>
                            ) : null}
                            {Number(o.promoDiscountPreTax || 0) > 0 ? (
                              <>
                                {" "}
                                · Coupon off (pre-tax): <SignedMoney value={o.promoDiscountPreTax} />
                              </>
                            ) : null}
                          </>
                        ) : (
                          <span>Entered: {o.promoCodeEntered}</span>
                        )}
                      </div>
                    ) : null}
                    <div style={{ marginTop: 6, fontSize: 13 }}>
                      {o.invoice?.invoiceNumber ? (
                        <>
                          <span>
                            Invoice: <strong>{o.invoice.invoiceNumber}</strong>
                          </span>
                          {resolveInvoiceHref(o.invoice?.pdfPath) ? (
                            <a
                              href={resolveInvoiceHref(o.invoice.pdfPath)}
                              target="_blank"
                              rel="noreferrer"
                              style={{ marginLeft: 10 }}
                            >
                              Preview PDF
                            </a>
                          ) : (
                            <span style={{ marginLeft: 10, color: "#6b7280" }}>PDF preparing…</span>
                          )}
                        </>
                      ) : (
                        <span style={{ color: "#6b7280" }}>
                          No invoice yet — wait a moment after opening this tab (sync runs automatically), or refresh the page.
                        </span>
                      )}
                    </div>
                    {editingOrderId === o.id && (
                      <div style={{ marginTop: 8, padding: 8, border: "1px dashed #9ca3af", borderRadius: 8, background: "#fff" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(160px, 1fr))", gap: 8 }}>
                          <input
                            placeholder="Customer name"
                            value={orderEditForm.customerName}
                            onChange={(e) => setOrderEditForm({ ...orderEditForm, customerName: e.target.value })}
                          />
                          <input
                            placeholder="Customer email"
                            value={orderEditForm.customerEmail}
                            onChange={(e) => setOrderEditForm({ ...orderEditForm, customerEmail: e.target.value })}
                          />
                          <input
                            placeholder="Customer phone"
                            value={orderEditForm.customerPhone}
                            onChange={(e) => setOrderEditForm({ ...orderEditForm, customerPhone: e.target.value })}
                          />
                        </div>
                        <div style={{ marginTop: 8, border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>Order items</div>
                          {orderEditItems.map((line, idx) => (
                            <div key={`oe-${idx}`} style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 8, marginBottom: 6 }}>
                              <select
                                value={line.recipeId}
                                onChange={(e) =>
                                  setOrderEditItems((prev) => prev.map((x, i) => (i === idx ? { ...x, recipeId: e.target.value } : x)))
                                }
                              >
                                <option value="">Select recipe</option>
                                {recipeOptionsSorted.map((r: any) => (
                                  <option key={r.id} value={r.id}>
                                    {r.name}
                                  </option>
                                ))}
                              </select>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="Qty lb"
                                value={line.quantityLbs}
                                onChange={(e) =>
                                  setOrderEditItems((prev) => prev.map((x, i) => (i === idx ? { ...x, quantityLbs: e.target.value } : x)))
                                }
                              />
                              <button type="button" onClick={() => setOrderEditItems((prev) => prev.filter((_, i) => i !== idx))} disabled={orderEditItems.length <= 1}>
                                Remove
                              </button>
                            </div>
                          ))}
                          <button type="button" onClick={() => setOrderEditItems((prev) => [...prev, { recipeId: "", quantityLbs: "" }])}>
                            + Add item
                          </button>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 12 }}>
                          Auto totals {"->"} Net: <SignedMoney value={orderEditTotals.netRevenue} /> | NJ tax: <SignedMoney value={orderEditTotals.salesTax} /> | Total (incl
                          tax): <SignedMoney value={orderEditTotals.subtotal} /> | COGS: <SignedMoney value={orderEditTotals.cogs} /> | Profit:{" "}
                          <SignedMoney value={orderEditTotals.margin} /> | Profit/lb:{" "}
                          <SignedMoney value={orderEditTotals.lbs > 0 ? orderEditTotals.margin / orderEditTotals.lbs : 0} />
                        </div>
                        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                          <button
                            type="button"
                            onClick={() =>
                              void submit(async () => {
                                const cleanItems = orderEditItems
                                  .map((x) => ({ recipeId: String(x.recipeId || "").trim(), quantityLbs: Number(x.quantityLbs || 0) }))
                                  .filter((x) => x.recipeId && x.quantityLbs > 0);
                                if (cleanItems.length === 0) throw new Error("Add at least one valid order item.");
                                await apiPut(`/operations/customers/${o.customerId}`, {
                                  name: orderEditForm.customerName.trim(),
                                  email: orderEditForm.customerEmail.trim() || undefined,
                                  phone: orderEditForm.customerPhone.trim() || undefined
                                });
                                await apiPut(`/operations/orders/${o.id}/items`, {
                                  items: cleanItems,
                                  notes: String(orderNoteById[o.id] ?? o.notes ?? "").trim()
                                });
                                setEditingOrderId("");
                              }, {
                                title: "Confirm order edit",
                                from: {
                                  customerName: orderCustomerName(o),
                                  customerEmail: orderCustomerEmail(o),
                                  customerPhone: orderCustomerPhone(o),
                                  items: String(o.productSummary || orderRecipeLabel(o)),
                                  lbs: Number(o.quantityLbs || 0),
                                  subtotal: Number(o.subtotal || 0),
                                  cogs: Number(o.cogs || 0)
                                },
                                to: {
                                  customerName: orderEditForm.customerName.trim(),
                                  customerEmail: orderEditForm.customerEmail.trim(),
                                  customerPhone: orderEditForm.customerPhone.trim(),
                                  items: orderEditItems
                                    .map((x) => {
                                      const rr = recipes.find((r: any) => r.id === x.recipeId);
                                      return rr && Number(x.quantityLbs || 0) > 0 ? `${rr.name} (${x.quantityLbs} lb)` : "";
                                    })
                                    .filter(Boolean),
                                  lbs: orderEditTotals.lbs,
                                  subtotal: Number(orderEditTotals.subtotal.toFixed(2)),
                                  cogs: Number(orderEditTotals.cogs.toFixed(2))
                                },
                                queueContext: pendingOrderQueueContext(o)
                              })
                            }
                          >
                            Save Edit
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void submit(async () => {
                                await apiDelete(`/operations/orders/${o.id}`);
                              }, {
                                title: "Confirm delete order",
                                from: {
                                  customer: String(o.customer?.name || ""),
                                  product: String(o.productSummary || orderRecipeLabel(o)),
                                  subtotal: Number(o.subtotal || 0),
                                  invoice: String(o.invoice?.invoiceNumber || "none")
                                },
                                to: "Order + invoice + payment will be permanently deleted.",
                                queueContext: pendingOrderQueueContext(o)
                              })
                            }
                            style={{ background: "#fee2e2", border: "1px solid #fca5a5", color: "#991b1b" }}
                          >
                            Delete Order
                          </button>
                          <button type="button" onClick={() => setEditingOrderId("")}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                  );
                })}
              </ul>
              </>
            )}
          </div>
        </section>
      )}

      {activeTab === "Making" && (
        <section>
          <h2>Making</h2>
          <p style={{ marginTop: 0, maxWidth: 860, color: "#395946" }}>
            Add <strong>multiple recipes at different pound amounts</strong>, then <strong>Save plan to sheet</strong> or <strong>Compute batches</strong>. That writes{" "}
            <strong>Making</strong>, recomputes <strong>BatchPlan_Auto</strong> (max 50 lb per batch, greedy split), fills <strong>Making_Print</strong> (one row per batch,
            ingredients across columns; salmon oil as pumps), and updates <strong>Shopping_Auto</strong> / <strong>RecipeBook_Auto</strong> from sheet formulas. Ingredient
            shares use each recipe&apos;s ratio columns <strong>normalized to their sum</strong> so batch weights add up like your legacy Create sheet. Pending demand below
            is reference only.
          </p>

          <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#fff", marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Pending Recipe Demand</h3>
            {makingDemandByRecipe.length === 0 ? (
              <p style={{ margin: 0 }}>No pending recipe demand.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Recipe</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Pending lbs</th>
                  </tr>
                </thead>
                <tbody>
                  {makingDemandByRecipe.map((r) => (
                    <tr key={r.recipeName}>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{r.recipeName}</td>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right", fontWeight: 700 }}>{r.lbs.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#fff", marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Manual Make Planner</h3>
            <p style={{ marginTop: 0, fontSize: 12, color: "#64748b" }}>
              Each row is one recipe + target lbs. Save pushes to the <strong>Making</strong> sheet (and Settings JSON); the sheet recalculates shopping and batches for{" "}
              <strong>all rows together</strong>.
            </p>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Production notes</label>
            <textarea
              value={makingPlanNotes}
              onChange={(e) => setMakingPlanNotes(e.target.value)}
              placeholder="Shopping reminders, vendor notes, batch labels…"
              rows={3}
              style={{ width: "100%", maxWidth: 720, padding: 8, borderRadius: 8, border: "1px solid #9ec1ac", marginBottom: 10, resize: "vertical" }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <button
                type="button"
                disabled={!!readOnlyLoading || makingComputeBusy || makingApplyBusy}
                onClick={() =>
                  void (async () => {
                    setMakingPlanSaveHint(null);
                    pushSheetWait("Saving plan to Google Sheet…");
                    try {
                      await apiPut("/operations/making-plan", { lines: makingLines, notes: makingPlanNotes });
                      const eng = await apiGet<any>("/operations/making-engine").catch(() => null);
                      setMakingEngine(eng?.ok ? eng : null);
                      setMakingPlanSaveHint("Saved to sheet; Making + auto tabs updated.");
                      window.setTimeout(() => setMakingPlanSaveHint(null), 3500);
                    } catch (e: any) {
                      setMakingPlanSaveHint(e?.message || "Could not save plan.");
                    } finally {
                      popSheetWait();
                    }
                  })()
                }
                style={{ background: "#166534", color: "#fff", border: "1px solid #14532d", padding: "8px 14px", borderRadius: 8 }}
              >
                Save plan to sheet
              </button>
              <button
                type="button"
                disabled={!!readOnlyLoading || makingComputeBusy || makingApplyBusy}
                onClick={() =>
                  void (async () => {
                    setMakingPlanSaveHint(null);
                    pushSheetWait("Loading plan from sheet…");
                    try {
                      const p = await apiGet<{ lines: Array<{ recipeId: string; amountLbs: string }>; notes: string }>("/operations/making-plan");
                      setMakingLines(p.lines?.length ? p.lines : [{ recipeId: "", amountLbs: "" }]);
                      setMakingPlanNotes(p.notes ?? "");
                      const eng = await apiGet<any>("/operations/making-engine").catch(() => null);
                      setMakingEngine(eng?.ok ? eng : null);
                      setMakingPlanSaveHint("Reloaded from sheet.");
                      window.setTimeout(() => setMakingPlanSaveHint(null), 3500);
                    } catch (e: any) {
                      setMakingPlanSaveHint(e?.message || "Could not reload plan.");
                    } finally {
                      popSheetWait();
                    }
                  })()
                }
              >
                Reload from sheet
              </button>
              <button
                type="button"
                disabled={!!readOnlyLoading || makingComputeBusy || makingApplyBusy}
                onClick={() =>
                  void (async () => {
                    setMakingPlanSaveHint(null);
                    setMakingComputeBusy(true);
                    pushSheetWait("Computing batches…");
                    try {
                      const computed = await apiPost<any>("/operations/making-plan/compute", {
                        lines: makingLines,
                        maxBatchLbs: 50
                      });
                      setMakingCompute(computed);
                      if (computed?.shoppingAuto) setMakingEngine(computed);
                      else {
                        const eng = await apiGet<any>("/operations/making-engine").catch(() => null);
                        setMakingEngine(eng?.ok ? eng : null);
                      }
                      setMakingPlanSaveHint("Synced to Making tab; batches from sheet engine.");
                    } catch (e: any) {
                      setMakingPlanSaveHint(e?.message || "Could not compute batch plan.");
                    } finally {
                      setMakingComputeBusy(false);
                      popSheetWait();
                    }
                  })()
                }
              >
                {makingComputeBusy ? "Computing..." : "Compute batches (max 50 lb)"}
              </button>
              <button
                type="button"
                disabled={!!readOnlyLoading || makingApplyBusy || makingComputeBusy || !displayRecipePlansForApply?.length}
                onClick={() =>
                  void (async () => {
                    setMakingPlanSaveHint(null);
                    setMakingApplyBusy(true);
                    pushSheetWait("Applying batches to inventory…");
                    try {
                      const plans = displayRecipePlansForApply;
                      for (const plan of plans) {
                        const rid = String(plan?.recipeId || "").trim();
                        const batches: number[] = Array.isArray(plan?.batches) ? plan.batches : [];
                        for (const b of batches) {
                          const lbs = Number(b || 0);
                          if (!rid || lbs <= 0) continue;
                          await apiPost("/operations/making", { recipeId: rid, batchLbs: lbs });
                        }
                      }
                      setMakingPlanSaveHint("Applied all batches to inventory.");
                      await refreshActiveTabData("Making");
                    } catch (e: any) {
                      setMakingPlanSaveHint(e?.message || "Could not apply batches.");
                    } finally {
                      setMakingApplyBusy(false);
                      popSheetWait();
                    }
                  })()
                }
              >
                {makingApplyBusy ? "Applying..." : "Apply batches to inventory"}
              </button>
              {makingPlanSaveHint ? <span style={{ fontSize: 13, color: "#395946" }}>{makingPlanSaveHint}</span> : null}
            </div>
            {makingLines.map((line, idx) => (
              <div key={`mk-${idx}`} style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 8, marginBottom: 8 }}>
                <select
                  value={line.recipeId}
                  onChange={(e) => setMakingLines((prev) => prev.map((x, i) => (i === idx ? { ...x, recipeId: e.target.value } : x)))}
                >
                  <option value="">Select recipe</option>
                  {recipeOptionsSorted.map((r: any) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Amount (lb)"
                  value={line.amountLbs}
                  onChange={(e) => setMakingLines((prev) => prev.map((x, i) => (i === idx ? { ...x, amountLbs: e.target.value } : x)))}
                />
                <button type="button" onClick={() => setMakingLines((prev) => prev.filter((_, i) => i !== idx))} disabled={makingLines.length <= 1}>
                  Remove
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setMakingLines((prev) => [...prev, { recipeId: "", amountLbs: "" }])}>
              + Add make line
            </button>
          </div>

          <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#fff", marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Batch planner (sheet engine)</h3>
            {!displayRecipePlansForApply?.length ? (
              <p style={{ margin: 0, color: "#64748b" }}>
                Enter recipe + lbs (one or many), then <strong>Save</strong> or <strong>Compute batches</strong> to refresh <strong>BatchPlan_Auto</strong> (max 50 lb
                per batch).
              </p>
            ) : (
              <>
                <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 10 }}>
                  <thead>
                    <tr>
                      <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Recipe</th>
                      <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Total lbs</th>
                      <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Batches</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRecipePlansForApply.map((r: any) => (
                      <tr key={String(r.recipeId || r.recipeName)}>
                        <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{String(r.recipeName || r.recipeId || "—")}</td>
                        <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{Number(r.totalLbs || 0).toFixed(2)}</td>
                        <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>
                          {(Array.isArray(r.batches) ? r.batches : []).map((b: number, i: number) => `#${i + 1}: ${Number(b || 0).toFixed(2)} lb`).join(" | ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h4 style={{ margin: "8px 0" }}>Ingredient totals</h4>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Ingredient</th>
                      <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Need</th>
                      <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>On hand</th>
                      <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Buy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(Array.isArray(displayIngredientTotalsFromCompute) ? displayIngredientTotalsFromCompute : []).map((r: any) => (
                      <tr key={String(r.ingredientName || "")}>
                        <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{String(r.ingredientName || "")}</td>
                        <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{Number(r.needLbs || 0).toFixed(2)}</td>
                        <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{Number(r.onHandLbs || 0).toFixed(2)}</td>
                        <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right", fontWeight: 700 }}>
                          {Number(r.buyLbs || 0).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#fff", marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Print layout (Making_Print)</h3>
            <p style={{ marginTop: 0, fontSize: 12, color: "#64748b" }}>
              The spreadsheet tab <strong>Making_Print</strong> is regenerated whenever batches refresh. Use it to copy or print: each batch is one row (recipe, batch size,
              then alternating ingredient / qty). Salmon oil uses pump counts. If you redeployed the script, run <code>fix()</code> once so the tab exists.
            </p>
            {makingPrintPreviewRows.length === 0 ? (
              <p style={{ margin: 0, color: "#64748b" }}>Save or compute to load batch rows.</p>
            ) : (
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
                  <tbody>
                    {makingPrintPreviewRows.map((row, idx) =>
                      row.pairs.length === 0 && !row.recipeName ? (
                        <tr key={`mpsp-${idx}`}>
                          <td colSpan={24} style={{ height: 10, border: "none" }} />
                        </tr>
                      ) : (
                        <tr key={`mpro-${idx}`}>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6, fontWeight: 700, verticalAlign: "top" }}>{row.recipeName}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6, whiteSpace: "nowrap", verticalAlign: "top" }}>{row.batchLabel}</td>
                          {row.pairs.flatMap((p) => [
                            <td key={`${idx}-${p.name}-n`} style={{ border: "1px solid #e5e7eb", padding: 6, verticalAlign: "top" }}>
                              {p.name}
                            </td>,
                            <td key={`${idx}-${p.name}-q`} style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right", verticalAlign: "top" }}>
                              {p.qty}
                            </td>
                          ])}
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#fff", marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Shopping list ({makingEngine?.shoppingAuto?.length ? "Shopping_Auto" : "preview"})</h3>
            {displayShoppingRows.length === 0 ? (
              <p style={{ margin: 0 }}>No ingredient demand yet.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Ingredient</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Need (lb)</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>On hand (lb)</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Buy (lb)</th>
                  </tr>
                </thead>
                <tbody>
                  {displayShoppingRows.map((r) => (
                    <tr key={r.ingredientName}>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{r.ingredientName}</td>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{r.needLbs.toFixed(2)}</td>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{r.onHandLbs.toFixed(2)}</td>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right", fontWeight: 700 }}>{r.buyLbs.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#fff" }}>
            <h3 style={{ marginTop: 0 }}>Recipe book</h3>
            <p style={{ marginTop: 0, fontSize: 12, color: "#64748b" }}>
              When synced, this shows <strong>RecipeBook_Auto</strong> (mix per recipe from the sheet). Below that is a local preview if the sheet rows are empty.
            </p>
            {Array.isArray(makingEngine?.recipeBookAuto) && makingEngine.recipeBookAuto.length > 0 ? (
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
                <thead>
                  <tr>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Recipe</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Ingredient</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Ratio %</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Lb / 50 batch</th>
                  </tr>
                </thead>
                <tbody>
                  {makingEngine.recipeBookAuto.filter(
                    (row: any) =>
                      makingNeedLbsPositive(Number(row.lbsPer50Batch)) || makingNeedLbsPositive(Number(row.ratioPct))
                  ).map((row: any, i: number) => (
                    <tr key={`rb-${i}-${row.recipeId}-${row.ingredientName}`}>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{String(row.recipeName || row.recipeId || "")}</td>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{String(row.ingredientName || "")}</td>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{Number(row.ratioPct || 0).toFixed(2)}</td>
                      <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{Number(row.lbsPer50Batch || 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : makingRecipeBook.length === 0 ? (
              <p style={{ margin: 0 }}>No recipes queued to make.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Recipe</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Recipe ID</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Batch</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Ingredient 1</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Amount 1</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Ingredient 2</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Amount 2</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Ingredient 3</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Amount 3</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Ingredient 4</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Amount 4</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Ingredient 5</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Amount 5</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Ingredient 6</th>
                    <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>Amount 6</th>
                  </tr>
                </thead>
                <tbody>
                  {makingRecipeBook.flatMap((r) =>
                    r.batches.map((b, idx) => {
                      const pairs = r.ingredientPairs.slice(0, 6).map((p) => {
                        const amt = (p.ratioPct / 100) * b;
                        const unit = p.unit.toLowerCase();
                        const amtText = `${amt.toFixed(2)} ${unit}`;
                        return { name: p.name, amountText: amtText };
                      });
                      while (pairs.length < 6) pairs.push({ name: "", amountText: "" });
                      return (
                        <tr key={`${r.recipeId}-${idx}`}>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{idx === 0 ? r.recipeName : ""}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{idx === 0 ? r.recipeId : ""}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{`Batch ${idx + 1} - ${b.toFixed(2)} lbs`}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{pairs[0].name}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{pairs[0].amountText}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{pairs[1].name}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{pairs[1].amountText}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{pairs[2].name}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{pairs[2].amountText}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{pairs[3].name}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{pairs[3].amountText}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{pairs[4].name}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{pairs[4].amountText}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6 }}>{pairs[5].name}</td>
                          <td style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "right" }}>{pairs[5].amountText}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {activeTab === "Archive Orders" && (
        <section>
          <h2>Archive Orders</h2>
          <p style={{ maxWidth: 800, color: "#395946" }}>
            Fulfilled and cancelled orders are listed here (newest first). Use the backfill once to generate <strong>invoice records + PDFs</strong> for any archive order
            that is still missing them—same rules as pending orders (order subtotal, NJ 6.625% tax, one line item). Then use <strong>Preview PDF</strong> on each card to save
            or print.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", width: "100%" }}>
              <input
                placeholder="Search archive orders by phone, name, email, invoice #, date, amount..."
                value={archiveOrderDraft}
                onChange={(e) => setArchiveOrderDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runArchiveSearch(archiveOrderDraft);
                  }
                }}
                style={{ minWidth: 280, flex: "1 1 240px", padding: "8px 10px", borderRadius: 8, border: "1px solid #9ec1ac" }}
              />
              <button
                type="button"
                onClick={() => void runArchiveSearch(archiveOrderDraft)}
                disabled={archiveSearchLoading}
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: "1px solid #166534",
                  background: archiveSearchLoading ? "#e2e8f0" : "#dcfce7",
                  color: archiveSearchLoading ? "#64748b" : "#14532d",
                  fontWeight: 700,
                  cursor: archiveSearchLoading ? "not-allowed" : "pointer"
                }}
              >
                {archiveSearchLoading ? "Searching..." : "Search Archive"}
              </button>
              {archiveOrderSearch ? (
                <button
                  type="button"
                  onClick={() => {
                    setArchiveOrderDraft("");
                    setArchiveOrderSearch("");
                  }}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 8,
                    border: "1px solid #94a3b8",
                    background: "#fff",
                    color: "#334155",
                    fontWeight: 600,
                    cursor: "pointer"
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            {archiveSearchSuggestions.length > 0 ? (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 680 }}>
                {archiveSearchSuggestions.map((s: any) => (
                  <button
                    key={`archive-suggestion-${s.id}`}
                    type="button"
                    onClick={() => {
                      const exact = s.phone || s.email || s.name || s.id;
                      setArchiveOrderDraft(exact);
                      void runArchiveSearch(exact);
                    }}
                    style={{
                      textAlign: "left",
                      border: "1px solid #d4e4d9",
                      background: "#fff",
                      borderRadius: 8,
                      padding: "8px 10px",
                      cursor: "pointer"
                    }}
                  >
                    <strong>{s.name}</strong> · {s.phone || "no phone"} · {s.email || "no email"} · #{s.invoice || "no invoice"} · <SignedMoney value={s.total} />
                  </button>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() =>
                void submit(
                  async () => {
                    setArchiveInvoiceBackfillMsg(null);
                    const res = await apiPost<{
                      created: number;
                      skipped: number;
                      pdfRepaired: number;
                      failed?: number;
                      errors?: string[];
                    }>("/operations/invoices/sync-archive", {});
                    let msg = `Archive invoice backfill finished.\nNew invoices + PDFs: ${res.created}. PDFs repaired: ${res.pdfRepaired}. Already had PDF (skipped): ${res.skipped}.`;
                    if (res.failed && res.failed > 0) {
                      msg += `\nFailed (could not create/repair): ${res.failed}.`;
                      if (res.errors?.length) msg += `\nSample errors:\n${res.errors.slice(0, 12).join("\n")}`;
                    }
                    setArchiveInvoiceBackfillMsg(msg);
                  },
                  {
                    title: "Create missing invoices for ALL archive orders",
                    from: "Only fulfilled/cancelled orders in Archive; skips any that already have a saved invoice PDF.",
                    to: "Create invoice + PDF for each archive order that needs one (one-time backfill you can run again safely)."
                  }
                )
              }
              style={{
                padding: "10px 16px",
                borderRadius: 10,
                border: "2px solid #166534",
                background: "#d1fae5",
                color: "#14532d",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              Create missing invoices / PDFs (archive backfill)
            </button>
          </div>
          {archiveInvoiceBackfillMsg ? (
            <p
              style={{
                margin: "0 0 12px",
                padding: "10px 12px",
                borderRadius: 10,
                background: "#ecfdf5",
                border: "1px solid #86efac",
                color: "#14532d",
                fontWeight: 600,
                whiteSpace: "pre-wrap",
                fontSize: 13,
                lineHeight: 1.45
              }}
            >
              {archiveInvoiceBackfillMsg}
            </p>
          ) : null}
          <div style={{ marginTop: 8, border: "1px solid #cfe0d4", borderRadius: 14, padding: 14, background: "#fafdfb" }}>
            {archiveOrderSearch && archiveOrderDraft.trim() !== archiveOrderSearch.trim() ? (
              <p style={{ marginTop: 0, color: "#5a6b5f", fontSize: 13 }}>Draft changed — press Search Archive to run this new query.</p>
            ) : null}
            <h3 style={{ marginTop: 0, color: "#14532d" }}>Summary (filtered list)</h3>
            <p style={{ marginTop: 0, fontSize: 14, color: "#1f4d37", lineHeight: 1.5 }}>
              <strong>{archiveSummary.orders}</strong> orders · <strong>{archiveSummary.lbs.toFixed(0)}</strong> lb · Total (incl tax){" "}
              <SignedMoney value={archiveSummary.revenue} /> · Net sales <SignedMoney value={archiveSummary.netRevenue} /> · NJ tax{" "}
              <SignedMoney value={archiveSummary.salesTax} /> · Profit <SignedMoney value={archiveSummary.profit} /> · Profit/lb{" "}
              <SignedMoney value={archiveSummary.lbs > 0 ? archiveSummary.profit / archiveSummary.lbs : 0} />
            </p>
            {filteredArchiveOrders.length === 0 ? (
              <p style={{ margin: 0, color: "#64748b" }}>No archived orders match your search.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {filteredArchiveOrders.map((o: any) => {
                  const m = orderMetrics(o);
                  const invHref = resolveInvoiceHref(o.invoice?.pdfPath);
                  const fulfilled = o.status === "FULFILLED";
                  return (
                    <li key={o.id} style={{ marginBottom: 16 }}>
                      <div
                        style={{
                          borderRadius: 14,
                          border: "1px solid #a7f3d0",
                          overflow: "hidden",
                          boxShadow: "0 2px 12px rgba(22, 101, 52, 0.08)",
                          background: "#fff"
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: 12,
                            padding: "14px 16px",
                            background: "linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 100%)",
                            borderBottom: "1px solid #bbf7d0"
                          }}
                        >
                          <div style={{ flex: "1 1 220px" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "#166534", textTransform: "uppercase" }}>Customer</div>
                            <div style={{ fontSize: 20, fontWeight: 800, color: "#14532d", marginTop: 2 }}>{o.customer?.name || "Unknown"}</div>
                            <div style={{ marginTop: 6, fontSize: 13, color: "#374151", lineHeight: 1.4 }}>
                              {o.customer?.phone ? <span>{o.customer.phone}</span> : <span style={{ color: "#9ca3af" }}>No phone</span>}
                              {o.customer?.email ? (
                                <>
                                  <br />
                                  <span style={{ wordBreak: "break-all" }}>{o.customer.email}</span>
                                </>
                              ) : null}
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "4px 10px",
                                borderRadius: 999,
                                fontSize: 12,
                                fontWeight: 800,
                                letterSpacing: "0.04em",
                                background: fulfilled ? "#bbf7d0" : "#fecaca",
                                color: fulfilled ? "#14532d" : "#991b1b",
                                border: fulfilled ? "1px solid #4ade80" : "1px solid #f87171"
                              }}
                            >
                              {o.status}
                            </span>
                            <div style={{ fontSize: 12, color: "#475569", textAlign: "right" }}>
                              Ordered
                              <br />
                              <strong style={{ color: "#0f172a" }}>{new Date(o.createdAt).toLocaleString()}</strong>
                            </div>
                          </div>
                        </div>

                        <div style={{ padding: "14px 16px" }}>
                          <div
                            style={{
                              marginBottom: 12,
                              padding: "10px 12px",
                              borderRadius: 10,
                              background: "#f8fafc",
                              border: "1px solid #e2e8f0",
                              fontSize: 14
                            }}
                          >
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: "0.05em" }}>Product</span>
                            <div style={{ marginTop: 4, fontWeight: 600, color: "#0f172a" }}>{orderRecipeLabel(o)}</div>
                          </div>

                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))",
                              gap: 8
                            }}
                          >
                            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 10px" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#166534", textTransform: "uppercase" }}>Weight</div>
                              <div style={{ marginTop: 4, fontSize: 16, fontWeight: 800, color: "#0f172a" }}>{m.lbs.toFixed(1)} lb</div>
                            </div>
                            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 10px" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#166534", textTransform: "uppercase" }}>Total (incl tax)</div>
                              <div style={{ marginTop: 4, fontSize: 15, fontWeight: 800 }}>
                                <SignedMoney value={m.subtotal} />
                              </div>
                            </div>
                            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 10px" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#166534", textTransform: "uppercase" }}>Net sale</div>
                              <div style={{ marginTop: 4, fontSize: 15, fontWeight: 800 }}>
                                <SignedMoney value={m.netRevenue} />
                              </div>
                            </div>
                            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 10px" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#166534", textTransform: "uppercase" }}>NJ tax</div>
                              <div style={{ marginTop: 4, fontSize: 15, fontWeight: 800 }}>
                                <SignedMoney value={m.salesTax} />
                              </div>
                            </div>
                            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 10px" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#166534", textTransform: "uppercase" }}>Net $ / lb</div>
                              <div style={{ marginTop: 4, fontSize: 15, fontWeight: 800 }}>
                                <SignedMoney value={m.pricePerLb} />
                              </div>
                            </div>
                            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 10px" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#166534", textTransform: "uppercase" }}>Profit</div>
                              <div style={{ marginTop: 4, fontSize: 15, fontWeight: 800 }}>
                                <SignedMoney value={m.profitTotal} />
                              </div>
                            </div>
                            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "8px 10px" }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#166534", textTransform: "uppercase" }}>Profit / lb</div>
                              <div style={{ marginTop: 4, fontSize: 15, fontWeight: 800 }}>
                                <SignedMoney value={m.profitPerLb} />
                              </div>
                            </div>
                          </div>

                          <div
                            style={{
                              marginTop: 12,
                              padding: "10px 12px",
                              borderRadius: 10,
                              background: "#fffbeb",
                              border: "1px solid #fde68a",
                              fontSize: 13,
                              color: "#92400e"
                            }}
                          >
                            <strong>Payment</strong> · {o.paymentMethod || "—"} · <strong>Paid</strong>{" "}
                            {o.paidAt ? new Date(o.paidAt).toLocaleString() : "—"} · <strong>Picked up</strong>{" "}
                            {o.pickedUpAt ? new Date(o.pickedUpAt).toLocaleString() : "—"}
                          </div>

                          {o.promoCode || o.promoCodeEntered ? (
                            <div style={{ marginTop: 10, fontSize: 13, color: "#1e3a5f" }}>
                              <strong>Promo</strong>{" "}
                              {o.promoCode ? (
                                <>
                                  {o.promoCode.code} — {o.promoCode.label}
                                  {Number(o.coOpKickbackOwed || 0) > 0 ? (
                                    <>
                                      {" "}
                                      · Kickback: <SignedMoney value={o.coOpKickbackOwed} />
                                    </>
                                  ) : null}
                                </>
                              ) : (
                                o.promoCodeEntered
                              )}
                            </div>
                          ) : null}

                          <div
                            style={{
                              marginTop: 12,
                              display: "flex",
                              flexWrap: "wrap",
                              alignItems: "center",
                              gap: 10,
                              padding: "10px 12px",
                              borderRadius: 10,
                              background: "#eff6ff",
                              border: "1px solid #bfdbfe"
                            }}
                          >
                            <div style={{ fontSize: 13, color: "#1e40af" }}>
                              <strong>Invoice</strong>{" "}
                              {o.invoice?.invoiceNumber ? (
                                <span>
                                  #{o.invoice.invoiceNumber}
                                </span>
                              ) : (
                                <span style={{ color: "#b45309" }}>Not generated yet — run archive backfill above.</span>
                              )}
                            </div>
                            {invHref ? (
                              <a
                                href={invHref}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  padding: "6px 12px",
                                  borderRadius: 8,
                                  background: "#86efac",
                                  color: "#14532d",
                                  fontWeight: 700,
                                  textDecoration: "none",
                                  fontSize: 13,
                                  border: "1px solid #166534"
                                }}
                              >
                                Preview PDF
                              </a>
                            ) : o.invoice?.invoiceNumber ? (
                              <span style={{ fontSize: 12, color: "#64748b" }}>PDF not on disk — run backfill to regenerate.</span>
                            ) : null}
                          </div>

                          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                            <input
                              placeholder="Note on this order"
                              value={orderNoteById[o.id] ?? o.notes ?? ""}
                              onChange={(e) => setOrderNoteById((prev) => ({ ...prev, [o.id]: e.target.value }))}
                              style={{ flex: "1 1 220px", minWidth: 200, padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                            />
                            <button
                              type="button"
                              onClick={() =>
                                void submit(async () => {
                                  await apiPut(`/operations/orders/${o.id}`, {
                                    notes: String(orderNoteById[o.id] ?? o.notes ?? "").trim()
                                  });
                                }, {
                                  title: "Confirm archived order note update",
                                  from: { orderId: o.id, note: o.notes || "" },
                                  to: { orderId: o.id, note: String(orderNoteById[o.id] ?? o.notes ?? "").trim() }
                                })
                              }
                            >
                              Save note
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void submit(async () => {
                                  await apiDelete(`/operations/orders/${o.id}`);
                                }, {
                                  title: "Confirm delete archived order",
                                  from: {
                                    customer: String(o.customer?.name || ""),
                                    product: String(o.productSummary || orderRecipeLabel(o)),
                                    subtotal: Number(o.subtotal || 0),
                                    invoice: String(o.invoice?.invoiceNumber || "none")
                                  },
                                  to: "Order + invoice + payment will be permanently deleted."
                                })
                              }
                              style={{ background: "#fee2e2", border: "1px solid #fca5a5", color: "#991b1b" }}
                            >
                              Delete order
                            </button>
                          </div>
                          {o.notes ? (
                            <div
                              style={{
                                marginTop: 10,
                                padding: "10px 12px",
                                borderRadius: 10,
                                background: "#f0fdf4",
                                border: "1px dashed #6ee7b7",
                                fontSize: 13,
                                color: "#14532d",
                                whiteSpace: "pre-wrap"
                              }}
                            >
                              <strong>Order note</strong>
                              <br />
                              {o.notes}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      )}

      {activeTab === "Expenses" && (
        <section>
          <h2>Expenses</h2>
          <p>Most recent on top, searchable, date-range filter, and tax-friendly recategorization.</p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => setExpenseSubTab("expenses")}
              style={{
                borderRadius: 8,
                border: expenseSubTab === "expenses" ? "2px solid #166534" : "1px solid #9ec1ac",
                background: expenseSubTab === "expenses" ? "#bbf7d0" : "#f7fbf8",
                color: expenseSubTab === "expenses" ? "#14532d" : "#1f4d37",
                fontWeight: 700
              }}
            >
              Expense Entries
            </button>
            <button
              type="button"
              onClick={() => setExpenseSubTab("depreciation")}
              style={{
                borderRadius: 8,
                border: expenseSubTab === "depreciation" ? "2px solid #166534" : "1px solid #9ec1ac",
                background: expenseSubTab === "depreciation" ? "#bbf7d0" : "#f7fbf8",
                color: expenseSubTab === "depreciation" ? "#14532d" : "#1f4d37",
                fontWeight: 700
              }}
            >
              Depreciation
            </button>
          </div>
          {expenseSubTab === "expenses" ? (
            <>
          <datalist id={EXPENSE_VENDOR_DATALIST_ID}>
            {commonExpenseVendors.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <div style={{ marginBottom: 10 }}>
            <button
              type="button"
              onClick={() =>
                void submit(async () => {
                  await apiPost("/operations/expenses/normalize-categories", {});
                  await loadFinanceData();
                }, {
                  title: "Confirm bulk expense recategorization",
                  from: { records: Number(expenseBreakdown.count || 0), mode: "Current category assignments" },
                  to: { records: Number(expenseBreakdown.count || 0), mode: "Normalized tax categories" }
                })
              }
            >
              Normalize Categories (All Existing)
            </button>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
              gap: 10,
              marginBottom: 12,
              alignItems: "end"
            }}
          >
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>From</label>
              <input
                type="date"
                value={expenseFilter.from}
                onChange={(e) => setExpenseFilter({ ...expenseFilter, from: e.target.value })}
                style={{ width: "100%", padding: 6, borderRadius: 8, border: "1px solid #9ec1ac" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>To</label>
              <input
                type="date"
                value={expenseFilter.to}
                onChange={(e) => setExpenseFilter({ ...expenseFilter, to: e.target.value })}
                style={{ width: "100%", padding: 6, borderRadius: 8, border: "1px solid #9ec1ac" }}
              />
            </div>
            <div style={{ gridColumn: "span 2", minWidth: 0 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>Search</label>
              <input
                placeholder="Vendor, category, notes…"
                value={expenseFilter.query}
                onChange={(e) => setExpenseFilter({ ...expenseFilter, query: e.target.value })}
                style={{ width: "100%", padding: 6, borderRadius: 8, border: "1px solid #9ec1ac" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#4b5563", marginBottom: 4 }}>Category</label>
              <select
                value={expenseFilter.category}
                onChange={(e) => setExpenseFilter({ ...expenseFilter, category: e.target.value })}
                style={{ width: "100%", padding: 6, borderRadius: 8, border: "1px solid #9ec1ac" }}
              >
                <option value="">All categories</option>
                {taxFriendlyExpenseCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <button
                type="button"
                onClick={() =>
                  void runReadOnly(async () => {
                    await loadFinanceData();
                  })
                }
                style={{ padding: "8px 14px", borderRadius: 8, fontWeight: 700 }}
              >
                Apply filters
              </button>
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(async () => {
                const receiptFiles = [...expensePendingReceiptFilesRef.current];
                const manualReceipt = expenseForm.receiptPath.trim();
                const created = await apiPost<{ id?: string }>("/operations/expenses", {
                  vendor: expenseForm.vendor.trim(),
                  category: expenseForm.category,
                  amount: Number(expenseForm.amount),
                  expenseDate: normalizeExpenseDateInput(expenseForm.expenseDate),
                  receiptPath: receiptFiles.length > 0 ? undefined : manualReceipt || undefined,
                  notes: buildExpenseNotes(expenseForm.description, expenseForm.payment),
                  paymentMethod: expenseForm.payment.trim()
                });
                const eid = String(created?.id || "").trim();
                if (receiptFiles.length > 0 && !eid) {
                  throw new Error(
                    "Expense was saved but the hub did not receive an expense id, so receipt files could not be uploaded. Refresh and try again, or redeploy the sheet Apps Script."
                  );
                }
                if (eid && receiptFiles.length > 0) {
                  const fd = new FormData();
                  for (const f of receiptFiles) fd.append("files", f);
                  await apiPostForm(`/operations/expenses/${encodeURIComponent(eid)}/receipts`, fd);
                }
                expensePendingReceiptFilesRef.current = [];
                setExpensePendingReceiptFiles([]);
                setExpenseForm({
                  vendor: "",
                  description: "",
                  category: "",
                  amount: "",
                  payment: DEFAULT_EXPENSE_PAYMENT_METHOD,
                  receiptPath: "",
                  expenseDate: localDateTimeInputValue()
                });
              });
            }}
          >
            <div style={{ border: "1px solid #d9e8de", borderRadius: 10, padding: 12, background: "#fbfefc", marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#14532d", marginBottom: 10 }}>Add expense</div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Vendor / payee</label>
                <input
                  placeholder="Type any vendor, or pick a suggestion below"
                  value={expenseForm.vendor}
                  onChange={(e) => setExpenseForm({ ...expenseForm, vendor: e.target.value })}
                  list={EXPENSE_VENDOR_DATALIST_ID}
                  autoComplete="off"
                  required
                  style={{ width: "100%", maxWidth: 480, padding: "8px 10px", borderRadius: 8, border: "1px solid #9ec1ac" }}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 8 }}>
                  <span style={{ fontSize: 11, color: "#64748b" }}>Quick fill:</span>
                  {commonExpenseVendors.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setExpenseForm((prev) => ({ ...prev, vendor: v }))}
                      style={{
                        padding: "4px 10px",
                        fontSize: 12,
                        borderRadius: 8,
                        border: "1px solid #86efac",
                        background: "#ecfdf5",
                        color: "#14532d",
                        fontWeight: 600,
                        cursor: "pointer"
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                  gap: 12,
                  width: "100%",
                  marginBottom: 12
                }}
              >
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Amount</label>
                  <input
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    value={expenseForm.amount}
                    onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })}
                    required
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #9ec1ac" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Category</label>
                  <select
                    value={expenseForm.category}
                    onChange={(e) => setExpenseForm({ ...expenseForm, category: e.target.value })}
                    required
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #9ec1ac" }}
                  >
                    <option value="">Choose category</option>
                    {taxFriendlyExpenseCategories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ gridColumn: "span 1", minWidth: 0 }}>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Date &amp; time</label>
                  <input
                    type="datetime-local"
                    value={expenseForm.expenseDate}
                    onChange={(e) => setExpenseForm({ ...expenseForm, expenseDate: e.target.value })}
                    title="Defaults to now; change if needed"
                    required
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #9ec1ac" }}
                  />
                </div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: 12,
                  width: "100%",
                  alignItems: "end"
                }}
              >
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Description (optional)</label>
                  <input
                    placeholder="What you bought"
                    value={expenseForm.description}
                    onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #9ec1ac" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Payment (optional)</label>
                  <input
                    placeholder="e.g. Credit Card, Zelle"
                    value={expenseForm.payment}
                    onChange={(e) => setExpenseForm({ ...expenseForm, payment: e.target.value })}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #9ec1ac" }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {paymentMethodOptions.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setExpenseForm((prev) => ({ ...prev, payment: p }))}
                        style={{
                          padding: "2px 8px",
                          fontSize: 11,
                          borderRadius: 6,
                          border: "1px solid #d1d5db",
                          background: "#fff",
                          cursor: "pointer"
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 4 }}>
                    Receipt link (optional)
                  </label>
                  <input
                    placeholder="Paste a Drive URL if you already have one"
                    value={expenseForm.receiptPath}
                    onChange={(e) => setExpenseForm({ ...expenseForm, receiptPath: e.target.value })}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #9ec1ac" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#374151", marginBottom: 4 }}>
                    Receipt photos / PDF (optional, multiple)
                  </label>
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    onChange={(e) => {
                      const list = e.target.files ? Array.from(e.target.files) : [];
                      expensePendingReceiptFilesRef.current = list;
                      setExpensePendingReceiptFiles(list);
                      e.currentTarget.value = "";
                    }}
                    style={{ fontSize: 13 }}
                  />
                  {expensePendingReceiptFiles.length > 0 ? (
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
                      {expensePendingReceiptFiles.length} file(s) queued — they upload to your Google Drive receipt folder when you add the expense (searchable file
                      names: date, vendor, description, category, amount, payment).
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <button type="submit">Add Expense</button>
              <span style={{ fontSize: 12, color: "#4b5563" }}>
                Vendor, amount, and category go to your Google Sheet. Receipt files go to the Drive folder set in Apps Script (<code>RECEIPTS_FOLDER_ID</code>) with
                descriptive names; the sheet stores the Drive link(s). You can attach several photos per expense.
              </span>
            </div>
          </form>
          <h3>Breakdown</h3>
          <p>
            Total: <SignedMoney value={expenseBreakdown.total} /> | Records: {expenseBreakdown.count ?? 0}
          </p>
          <ul>
            {(expenseBreakdown.byCategory || []).map((c: any) => (
              <li key={c.category}>
                {c.category}: <SignedMoney value={c.total} />
              </li>
            ))}
          </ul>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Date/Time</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Vendor/payee</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Description</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Category</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Amount</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Payment</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Receipt</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(expenseBreakdown.rows || []).map((x: any) => {
                  const details = parseExpenseRowDetails(x);
                  const receiptHrefs = (details.receiptUrls || [])
                    .map((u) => resolveReceiptHref(u))
                    .filter(Boolean);
                  const isEditing = editingExpenseId === x.id;
                  return (
                  <tr key={x.id}>
                    <td style={{ border: "1px solid #ccc", padding: 6 }}>
                      {isEditing ? (
                        <input
                          type="datetime-local"
                          value={expenseEditForm.expenseDate}
                          onChange={(e) => setExpenseEditForm({ ...expenseEditForm, expenseDate: e.target.value })}
                        />
                      ) : (
                        new Date(x.expenseDate).toLocaleString()
                      )}
                    </td>
                    <td style={{ border: "1px solid #ccc", padding: 6, minWidth: 140 }}>
                      {isEditing ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <input
                            value={expenseEditForm.vendor}
                            onChange={(e) => setExpenseEditForm({ ...expenseEditForm, vendor: e.target.value })}
                            list={EXPENSE_VENDOR_DATALIST_ID}
                            autoComplete="off"
                            style={{ width: "100%", minWidth: 120, padding: 4, borderRadius: 6, border: "1px solid #9ec1ac" }}
                          />
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {commonExpenseVendors.map((v) => (
                              <button
                                key={v}
                                type="button"
                                onClick={() => setExpenseEditForm((prev) => ({ ...prev, vendor: v }))}
                                style={{
                                  padding: "2px 6px",
                                  fontSize: 10,
                                  borderRadius: 6,
                                  border: "1px solid #86efac",
                                  background: "#f0fdf4",
                                  cursor: "pointer"
                                }}
                              >
                                {v}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        x.vendor
                      )}
                    </td>
                    <td style={{ border: "1px solid #ccc", padding: 6 }}>
                      {isEditing ? (
                        <input value={expenseEditForm.description} onChange={(e) => setExpenseEditForm({ ...expenseEditForm, description: e.target.value })} />
                      ) : (
                        details.description || "-"
                      )}
                    </td>
                    <td style={{ border: "1px solid #ccc", padding: 6 }}>
                      {isEditing ? (
                        <select
                          value={expenseEditForm.category}
                          onChange={(e) => setExpenseEditForm({ ...expenseEditForm, category: e.target.value })}
                        >
                          {taxFriendlyExpenseCategories.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      ) : (
                        x.category
                      )}
                    </td>
                    <td style={{ border: "1px solid #ccc", padding: 6 }}>
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          value={expenseEditForm.amount}
                          onChange={(e) => setExpenseEditForm({ ...expenseEditForm, amount: e.target.value })}
                        />
                      ) : (
                        <SignedMoney value={x.amount} />
                      )}
                    </td>
                    <td style={{ border: "1px solid #ccc", padding: 6 }}>
                      {isEditing ? (
                        <input value={expenseEditForm.payment} onChange={(e) => setExpenseEditForm({ ...expenseEditForm, payment: e.target.value })} />
                      ) : (
                        details.payment || "-"
                      )}
                    </td>
                    <td style={{ border: "1px solid #ccc", padding: 6 }}>
                      {isEditing ? (
                        <input
                          placeholder="URLs separated by |"
                          value={expenseEditForm.receiptPath}
                          onChange={(e) => setExpenseEditForm({ ...expenseEditForm, receiptPath: e.target.value })}
                        />
                      ) : receiptHrefs.length > 0 ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          {receiptHrefs.map((href, ri) => (
                            <div key={`${x.id}-rc-${ri}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                              {isImageReceipt(href) ? (
                                <img
                                  src={href}
                                  alt={`Receipt ${ri + 1}`}
                                  style={{ width: 36, height: 36, objectFit: "cover", border: "1px solid #ddd", borderRadius: 4, cursor: "pointer" }}
                                  onClick={() => setExpenseReceiptPreview({ href, isPdf: false, name: `Receipt ${ri + 1}` })}
                                />
                              ) : null}
                              <button
                                type="button"
                                onClick={() =>
                                  setExpenseReceiptPreview({
                                    href,
                                    isPdf: !isImageReceipt(href),
                                    name: isPdfReceipt(href) ? `Receipt PDF ${ri + 1}` : `Receipt ${ri + 1}`
                                  })
                                }
                              >
                                P{ri + 1}
                              </button>
                              <a href={href} target="_blank" rel="noreferrer">
                                Open{receiptHrefs.length > 1 ? ` ${ri + 1}` : ""}
                              </a>
                            </div>
                          ))}
                        </div>
                      ) : (
                        details.receipt || "-"
                      )}
                    </td>
                    <td style={{ border: "1px solid #ccc", padding: 6 }}>
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void submit(async () => {
                                await apiPut(`/operations/expenses/${x.id}`, {
                                  vendor: expenseEditForm.vendor.trim(),
                                  category: expenseEditForm.category,
                                  amount: Number(expenseEditForm.amount || 0),
                                  expenseDate: normalizeExpenseDateInput(expenseEditForm.expenseDate),
                                  receiptPath: expenseEditForm.receiptPath.trim(),
                                  notes: buildExpenseNotes(expenseEditForm.description, expenseEditForm.payment),
                                  paymentMethod: expenseEditForm.payment.trim()
                                });
                                setEditingExpenseId("");
                                await loadFinanceData();
                              }, {
                                title: "Confirm expense update",
                                from: {
                                  date: new Date(x.expenseDate).toLocaleString(),
                                  vendor: x.vendor,
                                  description: details.description || "",
                                  category: x.category,
                                  amount: Number(x.amount || 0),
                                  payment: details.payment || "",
                                  receipt: details.receipt || ""
                                },
                                to: {
                                  date: expenseEditForm.expenseDate,
                                  vendor: expenseEditForm.vendor.trim(),
                                  description: expenseEditForm.description.trim(),
                                  category: expenseEditForm.category,
                                  amount: Number(expenseEditForm.amount || 0),
                                  payment: expenseEditForm.payment.trim(),
                                  receipt: expenseEditForm.receiptPath.trim()
                                }
                              })
                            }
                          >
                            Save
                          </button>
                          <button type="button" style={{ marginLeft: 6 }} onClick={() => setEditingExpenseId("")}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingExpenseId(x.id);
                            setExpenseEditForm({
                              vendor: String(x.vendor || ""),
                              description: details.description || "",
                              category: String(x.category || "Other"),
                              amount: String(Number(x.amount || 0)),
                              expenseDate: localDateTimeInputValue(new Date(x.expenseDate)),
                              payment: details.payment || "",
                              receiptPath: (details.receiptUrls || []).join(" | ") || details.receipt || ""
                            });
                          }}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
            </>
          ) : (
            <div style={{ border: "1px solid #d9e8de", borderRadius: 10, padding: 10, background: "#fff" }}>
              <p style={{ marginTop: 0 }}>
                Added your equipment list with 7-year depreciation schedule. Method and Section 179 flags are included exactly as provided.
              </p>
              <p>
                Assets: {depreciationRows.length} | Paid amount: <SignedMoney value={depreciationSummary.paidAmount} /> | Depreciable basis:{" "}
                <SignedMoney value={depreciationSummary.depreciableBasis} /> | Annual depreciation: <SignedMoney value={depreciationSummary.yearlyDepreciation} /> |
                Monthly depreciation: <SignedMoney value={depreciationSummary.monthlyDepreciation} /> | Accumulated depreciation:{" "}
                <SignedMoney value={depreciationSummary.accumulated} /> | Book value: <SignedMoney value={depreciationSummary.bookValue} />
              </p>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Placed in Service</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Vendor</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Asset</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Category</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Paid Amount</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Depreciable Basis</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Method</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Section 179</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Life</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Yearly Depreciation</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Monthly Depreciation</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Accumulated</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Book Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {depreciationRows.map((row) => (
                      <tr key={row.id}>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{row.placedInService}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{row.vendor}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{row.assetName}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{row.category}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}><SignedMoney value={row.paidAmount} /></td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}><SignedMoney value={row.depreciableBasis} /></td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{row.method}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{row.section179 ? "Yes" : "No"}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{row.recoveryYears} years</td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}><SignedMoney value={row.yearlyDepreciation} /></td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}><SignedMoney value={row.monthlyDepreciation} /></td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}><SignedMoney value={row.accumulated} /></td>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}><SignedMoney value={row.bookValue} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {activeTab === "Sales" && (
        <section>
          <h2>Sales</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="date" value={financeRange.from} onChange={(e) => setFinanceRange({ ...financeRange, from: e.target.value })} />
            <input type="date" value={financeRange.to} onChange={(e) => setFinanceRange({ ...financeRange, to: e.target.value })} />
            <button type="button" onClick={() => void runReadOnly(loadFinanceData)}>
              Refresh Sales
            </button>
          </div>
          <ul>
            <li>Orders: {salesSummary.orderCount ?? 0}</li>
            <li>
              Gross Sales: <SignedMoney value={salesSummary.grossSales} />
            </li>
            <li>
              Paid Sales: <SignedMoney value={salesSummary.paidSales} />
            </li>
            <li>
              Unpaid Sales: <SignedMoney value={salesSummary.unpaidSales} />
            </li>
          </ul>
        </section>
      )}

      {activeTab === "Profit" && (
        <section>
          <h2>Revenue vs Expenses</h2>
          <p>
            Revenue is tax-included sales. COGS is food/ingredient cost from each order. Operating expenses exclude ingredient-category purchases (Meats, Organs, Dairy, Fruits/Veggies,
            Fats, Supplements, Packaging) — those are inventory; COGS already reflects product cost. Net profit = gross profit − those operating expenses.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <input type="date" value={financeRange.from} onChange={(e) => setFinanceRange({ ...financeRange, from: e.target.value })} />
            <input type="date" value={financeRange.to} onChange={(e) => setFinanceRange({ ...financeRange, to: e.target.value })} />
            <button type="button" onClick={() => void runReadOnly(loadFinanceData)}>
              Refresh
            </button>
          </div>
          <ul>
            <li>
              Revenue (tax incl.): <SignedMoney value={profitSummary.revenue} />
            </li>
            <li>
              COGS (food cost): <SignedMoney value={profitSummary.cogs ?? 0} />
            </li>
            <li>
              Gross profit: <SignedMoney value={profitSummary.grossProfit ?? 0} />
            </li>
            <li>
              Operating expenses (excludes inventory purchase categories): <SignedMoney value={profitSummary.operatingExpenses} />
            </li>
            {Number(profitSummary.expensesInventoryPurchases ?? 0) > 0 ? (
              <li style={{ color: "#475569", fontSize: 14 }}>
                Inventory / raw-material expenses (excluded — in COGS via orders):{" "}
                <SignedMoney value={Number(profitSummary.expensesInventoryPurchases ?? 0)} />
              </li>
            ) : null}
            <li>
              Net profit: <SignedMoney value={profitSummary.netProfit} />
            </li>
          </ul>
        </section>
      )}

      {activeTab === "Tax" && (
        <section>
          <h2>Tax (NJ)</h2>
          <p>Filter a date range to calculate NJ tax and deductible categories for that exact period.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(160px, 1fr))", gap: 8, maxWidth: 980 }}>
            <input
              type="date"
              value={financeRange.from}
              onChange={(e) => setFinanceRange({ ...financeRange, from: e.target.value })}
              title="From date"
            />
            <input
              type="date"
              value={financeRange.to}
              onChange={(e) => setFinanceRange({ ...financeRange, to: e.target.value })}
              title="To date"
            />
            <label>
              NJ Sales Tax Rate
              <input type="number" step="0.00001" value={njTaxRate} onChange={(e) => setNjTaxRate(e.target.value)} />
            </label>
            <button type="button" onClick={() => void runReadOnly(loadFinanceData)}>
              Recalculate Tax
            </button>
          </div>
          <ul>
            <li>
              Taxable Sales: <SignedMoney value={taxSummary.taxableSales} />
            </li>
            <li>
              Estimated Sales Tax Due: <SignedMoney value={taxSummary.estimatedSalesTaxDue} />
            </li>
            <li>
              Deductible Expenses: <SignedMoney value={taxSummary.deductibleExpenses} />
            </li>
          </ul>
          <h3>Deductible By Category</h3>
          <ul>
            {(taxSummary.deductibleByCategory || []).map((item: any) => (
              <li key={item.category}>
                {item.category}: <SignedMoney value={item.total} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {activeTab === "Invoices" && (
        <section>
          <h2>Invoice Creator</h2>
          <p style={{ maxWidth: 900, color: "#395946", lineHeight: 1.55 }}>
            Put your logo in <code>Backend/Invoices/</code> — e.g. <code>color logo.png</code> (see <code>Invoices/README.md</code>). Use the green button to create any missing invoices for <strong>pending</strong> and <strong>archive</strong> orders, then rebuild <strong>every</strong> PDF with the current template.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 14 }}>
            <button
              type="button"
              onClick={() =>
                void submit(
                  async () => {
                    setInvoiceRegenerateMsg(null);
                    type SyncBatch = {
                      created: number;
                      skipped: number;
                      pdfRepaired: number;
                      failed: number;
                      errors: string[];
                    };
                    const res = await apiPost<{
                      pendingSync: SyncBatch;
                      archiveSync: SyncBatch;
                      regenerate: {
                        updated: number;
                        failed: number;
                        total: number;
                        invoicesDir: string;
                        logoUsed: string | null;
                        errors: string[];
                      };
                    }>("/operations/invoices/sync-all-and-regenerate", {});
                    const line = (label: string, s: SyncBatch) =>
                      `${label}: new invoice+PDF ${s.created}, PDF repaired ${s.pdfRepaired}, skipped ${s.skipped}, failed ${s.failed}` +
                      (s.errors?.length ? `\n  ${s.errors.slice(0, 10).join("\n  ")}` : "");
                    const g = res.regenerate;
                    let msg = `${line("Pending orders (NEW/CONFIRMED)", res.pendingSync)}\n${line("Archive (FULFILLED/CANCELLED)", res.archiveSync)}\n\nRegenerated ${g.updated} of ${g.total} invoice PDF(s).\nFolder: ${g.invoicesDir}`;
                    if (g.logoUsed) msg += `\nLogo: ${g.logoUsed}`;
                    else msg += `\nNo logo file found (add color logo.png in Invoices/ or set INVOICE_LOGO_PATH).`;
                    msg += `\nPDF failures: ${g.failed}.`;
                    if (g.errors?.length) msg += `\n${g.errors.slice(0, 12).join("\n")}`;
                    setInvoiceRegenerateMsg(msg);
                    await loadAll();
                  },
                  {
                    title: "Sync ALL pending + archive orders, then rebuild EVERY invoice PDF",
                    from: "Every NEW/CONFIRMED/FULFILLED/CANCELLED order: create missing invoices/PDFs where needed, then overwrite all PDFs in Backend/Invoices/ with the current template + logo.",
                    to: "Run full sync + full regenerate (can take a while if you have many orders)."
                  }
                )
              }
              style={{
                padding: "12px 18px",
                borderRadius: 10,
                border: "2px solid #166534",
                background: "#86efac",
                color: "#14532d",
                fontWeight: 800,
                cursor: "pointer"
              }}
            >
              Sync pending + archive &amp; rebuild ALL invoice PDFs
            </button>
            <button
              type="button"
              onClick={() =>
                void submit(
                  async () => {
                    setInvoiceRegenerateMsg(null);
                    const res = await apiPost<{
                      updated: number;
                      failed: number;
                      total: number;
                      invoicesDir: string;
                      logoUsed: string | null;
                      errors: string[];
                    }>("/operations/invoices/regenerate-all", {});
                    let msg = `Regenerated ${res.updated} of ${res.total} invoice PDF(s) only (no new invoices).\nFolder: ${res.invoicesDir}`;
                    if (res.logoUsed) msg += `\nLogo: ${res.logoUsed}`;
                    else msg += `\nNo logo file found.`;
                    msg += `\nFailed: ${res.failed}.`;
                    if (res.errors?.length) msg += `\n${res.errors.slice(0, 15).join("\n")}`;
                    setInvoiceRegenerateMsg(msg);
                    await loadAll();
                  },
                  {
                    title: "Regenerate PDFs only",
                    from: "Existing invoices only",
                    to: "Overwrite every PDF; does not create invoices for orders missing them."
                  }
                )
              }
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "2px solid #1d4ed8",
                background: "#dbeafe",
                color: "#1e3a8a",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              PDFs only (no new invoices)
            </button>
            <a
              href={`${getPublicApiBase()}/uploads/invoices/DEMO-sample-invoice.pdf`}
              target="_blank"
              rel="noreferrer"
              style={{ fontWeight: 600, color: "#1d4ed8" }}
            >
              Open demo sample PDF
            </a>
          </div>
          {invoiceRegenerateMsg ? (
            <p
              style={{
                margin: "0 0 14px",
                padding: "10px 12px",
                borderRadius: 10,
                background: "#eff6ff",
                border: "1px solid #93c5fd",
                color: "#1e3a8a",
                fontWeight: 600,
                whiteSpace: "pre-wrap",
                fontSize: 13,
                lineHeight: 1.45
              }}
            >
              {invoiceRegenerateMsg}
            </p>
          ) : null}
          <p>Professional invoice builder with line items, tax, discount, printable format, and save-to-record.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
            <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#fff" }}>
              <h3 style={{ marginTop: 0 }}>Invoice Setup</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <select
                  value={invoiceBuilder.orderId}
                  onChange={(e) => {
                    setInvoiceBuilder({ ...invoiceBuilder, orderId: e.target.value });
                    loadInvoiceFromOrder(e.target.value);
                  }}
                >
                  <option value="">Select order (optional)</option>
                  {orders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.customer?.name} - ${fmtMoney(o.subtotal)}
                    </option>
                  ))}
                </select>
                <input
                  placeholder="Invoice #"
                  value={invoiceBuilder.invoiceNumber}
                  onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, invoiceNumber: e.target.value })}
                />
                <input
                  type="date"
                  value={invoiceBuilder.invoiceDate}
                  onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, invoiceDate: e.target.value })}
                />
                <input
                  type="date"
                  value={invoiceBuilder.dueDate}
                  onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, dueDate: e.target.value })}
                />
                <input
                  placeholder="Tax % (NJ 6.625)"
                  type="number"
                  step="0.001"
                  value={invoiceBuilder.taxRate}
                  onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, taxRate: e.target.value })}
                />
                <input
                  placeholder="Discount $"
                  type="number"
                  step="0.01"
                  value={invoiceBuilder.discount}
                  onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, discount: e.target.value })}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
                <input placeholder="Bill To Name" value={invoiceBuilder.billToName} onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, billToName: e.target.value })} />
                <input placeholder="Bill To Email" value={invoiceBuilder.billToEmail} onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, billToEmail: e.target.value })} />
                <input placeholder="Bill To Phone" value={invoiceBuilder.billToPhone} onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, billToPhone: e.target.value })} />
              </div>
              <input
                style={{ width: "100%", marginTop: 8 }}
                placeholder="Bill To Address"
                value={invoiceBuilder.billToAddress}
                onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, billToAddress: e.target.value })}
              />
              <input style={{ width: "100%", marginTop: 8 }} placeholder="Notes" value={invoiceBuilder.notes} onChange={(e) => setInvoiceBuilder({ ...invoiceBuilder, notes: e.target.value })} />
              <h3>Line Items</h3>
              {invoiceLines.map((line, idx) => (
                <div key={`invoice-line-${idx}`} style={{ display: "grid", gridTemplateColumns: "2fr .6fr .8fr auto", gap: 8, marginBottom: 6 }}>
                  <input
                    placeholder="Description"
                    value={line.description}
                    onChange={(e) => {
                      const next = [...invoiceLines];
                      next[idx] = { ...next[idx], description: e.target.value };
                      setInvoiceLines(next);
                    }}
                  />
                  <input
                    placeholder="Qty"
                    type="number"
                    step="0.01"
                    value={line.quantity}
                    onChange={(e) => {
                      const next = [...invoiceLines];
                      next[idx] = { ...next[idx], quantity: e.target.value };
                      setInvoiceLines(next);
                    }}
                  />
                  <input
                    placeholder="Unit Price"
                    type="number"
                    step="0.01"
                    value={line.unitPrice}
                    onChange={(e) => {
                      const next = [...invoiceLines];
                      next[idx] = { ...next[idx], unitPrice: e.target.value };
                      setInvoiceLines(next);
                    }}
                  />
                  <button type="button" onClick={() => setInvoiceLines(invoiceLines.filter((_, i) => i !== idx))} disabled={invoiceLines.length === 1}>
                    Remove
                  </button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" onClick={() => setInvoiceLines([...invoiceLines, { description: "", quantity: "1", unitPrice: "" }])}>
                  + Add Line
                </button>
                <button type="button" onClick={printInvoiceDocument}>
                  Print / Save PDF
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void submit(async () => {
                      if (!invoiceBuilder.orderId) throw new Error("Select an order before saving invoice record.");
                      if (!invoiceBuilder.invoiceNumber.trim()) throw new Error("Invoice number is required.");
                      await apiPost("/operations/invoices", {
                        orderId: invoiceBuilder.orderId,
                        invoiceNumber: invoiceBuilder.invoiceNumber.trim(),
                        amount: Number(invoiceCalc.total.toFixed(2))
                      });
                    })
                  }
                >
                  Save Invoice Record
                </button>
              </div>
            </div>

            <div style={{ border: "1px solid #cfe0d4", borderRadius: 12, padding: 12, background: "#f9fcfa" }}>
              <h3 style={{ marginTop: 0 }}>Live Total</h3>
              <div style={{ fontSize: 14, lineHeight: 1.9 }}>
                <div>
                  Subtotal:{" "}
                  <strong>
                    <SignedMoney value={invoiceCalc.subtotal} />
                  </strong>
                </div>
                <div>
                  Discount:{" "}
                  <strong>
                    <span style={{ color: moneyColor(-invoiceCalc.discount) }}>-${fmtMoney(invoiceCalc.discount)}</span>
                  </strong>
                </div>
                <div>
                  Tax ({Number(invoiceBuilder.taxRate || 0).toFixed(3)}%):{" "}
                  <strong>
                    <SignedMoney value={invoiceCalc.tax} />
                  </strong>
                </div>
                <div style={{ marginTop: 8, fontSize: 22 }}>
                  Total:{" "}
                  <strong style={{ color: moneyColor(invoiceCalc.total) }}>
                    ${fmtMoney(invoiceCalc.total)}
                  </strong>
                </div>
              </div>
            </div>
          </div>

          <h3>Mark Invoice Paid</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const invoice = invoices.find((inv: any) => inv.id === markPaidForm.invoiceId);
              void submit(async () => {
                await apiPost("/operations/invoices/mark-paid", { ...markPaidForm, amount: Number(markPaidForm.amount) });
                setMarkPaidForm({ invoiceId: "", amount: "", status: "PAID" });
              }, {
                title: "Confirm invoice payment update",
                from: {
                  invoiceNumber: invoice?.invoiceNumber || markPaidForm.invoiceId,
                  previousStatus: invoice?.payment?.status ?? "UNPAID",
                  previousAmount: Number(invoice?.payment?.amount || 0)
                },
                to: {
                  invoiceNumber: invoice?.invoiceNumber || markPaidForm.invoiceId,
                  newStatus: markPaidForm.status || "PAID",
                  newAmount: Number(markPaidForm.amount || 0)
                }
              });
            }}
          >
            <select value={markPaidForm.invoiceId} onChange={(e) => setMarkPaidForm({ ...markPaidForm, invoiceId: e.target.value })} required>
              <option value="">Select invoice</option>
              {invoices.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.invoiceNumber}
                </option>
              ))}
            </select>
            <input placeholder="Amount paid" type="number" step="0.01" value={markPaidForm.amount} onChange={(e) => setMarkPaidForm({ ...markPaidForm, amount: e.target.value })} required />
            <button type="submit">Mark Paid</button>
          </form>
          <ul>
            {rows.invoices.map((inv: any) => (
              <li key={inv.id}>
                {inv.invoiceNumber} - <SignedMoney value={inv.amount} /> ({inv.payment?.status ?? "UNPAID"})
              </li>
            ))}
          </ul>
        </section>
      )}

      {activeTab === "Coupons & Co-ops" && (
        <section style={{ maxWidth: 1100 }}>
          <h2>Coupons & Co-ops</h2>
          <p style={{ marginTop: 0, color: "#395946", maxWidth: 800 }}>
            <strong>Coupon</strong> vs <strong>Co-op</strong> is a label for your records. Either type can use <strong>% or $ off</strong> pre-tax (customer pays less) and{" "}
            <strong>% or $ kickback</strong> on pre-tax merchandise (owed to an organizer). Both can be set on the same code. Codes are case-insensitive; customers enter them on{" "}
            <strong>Submit Order</strong>.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 16,
              marginBottom: 24,
              padding: 16,
              border: "1px solid #cfe0d4",
              borderRadius: 12,
              background: "#fafdfb"
            }}
          >
            <div style={{ gridColumn: "1 / -1", fontWeight: 800, color: "#14532d" }}>Create code</div>
            <input
              placeholder="Code (e.g. SAVE10)"
              value={newPromoForm.code}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, code: e.target.value })}
            />
            <input
              placeholder="Label / co-op name (optional — defaults to code)"
              value={newPromoForm.label}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, label: e.target.value })}
            />
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              Type
              <select
                value={newPromoForm.kind}
                onChange={(e) => setNewPromoForm({ ...newPromoForm, kind: e.target.value as "COUPON" | "COOP" })}
              >
                <option value="COUPON">Coupon (label)</option>
                <option value="COOP">Co-op (label)</option>
              </select>
            </label>
            <input
              placeholder="% off pre-tax merchandise"
              type="number"
              step="0.01"
              value={newPromoForm.discountPercent}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, discountPercent: e.target.value })}
            />
            <input
              placeholder="$ off pre-tax (fixed)"
              type="number"
              step="0.01"
              value={newPromoForm.discountFixed}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, discountFixed: e.target.value })}
            />
            <input
              placeholder="Kickback % of pre-tax (before discount)"
              type="number"
              step="0.01"
              value={newPromoForm.kickbackPercent}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, kickbackPercent: e.target.value })}
            />
            <input
              placeholder="Flat $ kickback per order"
              type="number"
              step="0.01"
              value={newPromoForm.kickbackFixed}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, kickbackFixed: e.target.value })}
            />
            <textarea
              placeholder="Payee notes (Zelle email, who to pay, etc.)"
              value={newPromoForm.payeeNotes}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, payeeNotes: e.target.value })}
              rows={2}
              style={{ gridColumn: "1 / -1", fontFamily: "inherit" }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={newPromoForm.active}
                onChange={(e) => setNewPromoForm({ ...newPromoForm, active: e.target.checked })}
              />
              Active
            </label>
            <button
              type="button"
              style={{ padding: "10px 16px", fontWeight: 700 }}
              onClick={() =>
                void submit(async () => {
                  if (!newPromoForm.code.trim()) throw new Error("Code is required.");
                  const body: Record<string, unknown> = {
                    code: newPromoForm.code.trim(),
                    label: newPromoForm.label.trim() || newPromoForm.code.trim(),
                    kind: newPromoForm.kind,
                    active: newPromoForm.active
                  };
                  if (newPromoForm.discountPercent !== "") body.discountPercent = Number(newPromoForm.discountPercent);
                  if (newPromoForm.discountFixed !== "") body.discountFixed = Number(newPromoForm.discountFixed);
                  if (newPromoForm.kickbackPercent !== "") body.kickbackPercent = Number(newPromoForm.kickbackPercent);
                  if (newPromoForm.kickbackFixed !== "") body.kickbackFixed = Number(newPromoForm.kickbackFixed);
                  if (newPromoForm.payeeNotes.trim()) body.payeeNotes = newPromoForm.payeeNotes.trim();
                  await apiPost("/operations/promo-codes", body);
                  const [pc, cs, kb] = await Promise.all([
                    apiGet<any[]>("/operations/promo-codes"),
                    apiGet<any[]>("/operations/promo-codes/coop-summary"),
                    apiGet<any[]>("/operations/kickback-payments")
                  ]);
                  setPromoCodes(pc);
                  setCoopSummary(cs);
                  setKickbackPayments(kb);
                  setNewPromoForm({
                    code: "",
                    label: "",
                    kind: "COUPON",
                    discountPercent: "",
                    discountFixed: "",
                    kickbackPercent: "",
                    kickbackFixed: "",
                    payeeNotes: "",
                    active: true
                  });
                }, {
                  title: "Create promo / co-op code",
                  from: "(new)",
                  to: { code: newPromoForm.code.trim(), kind: newPromoForm.kind, label: newPromoForm.label.trim() }
                })
              }
            >
              Save new code
            </button>
          </div>

          <h3 style={{ color: "#14532d" }}>Kickbacks owed by code (from orders)</h3>
          <p style={{ fontSize: 13, color: "#64748b", marginTop: 0 }}>
            Totals roll up every order that used a <strong>Co-op</strong> code. Pay organizers from your books; this view is for tracking only.
          </p>
          {coopSummary.length === 0 ? (
            <p style={{ color: "#64748b" }}>No co-op orders yet.</p>
          ) : (
            <div style={{ overflowX: "auto", marginBottom: 28 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "2px solid #cfe0d4" }}>
                    <th style={{ padding: "8px 10px" }}>Code</th>
                    <th style={{ padding: "8px 10px" }}>Co-op</th>
                    <th style={{ padding: "8px 10px" }}>Orders</th>
                    <th style={{ padding: "8px 10px" }}>Revenue (tax incl.)</th>
                    <th style={{ padding: "8px 10px" }}>Kickback owed</th>
                    <th style={{ padding: "8px 10px" }}>Paid (ledger)</th>
                    <th style={{ padding: "8px 10px" }}>Outstanding</th>
                    <th style={{ padding: "8px 10px" }}>Last paid</th>
                    <th style={{ padding: "8px 10px" }}>Payee notes</th>
                  </tr>
                </thead>
                <tbody>
                  {coopSummary.map((row) => (
                    <tr key={row.promoCodeId} style={{ borderBottom: "1px solid #e2e8f0" }}>
                      <td style={{ padding: "8px 10px", fontWeight: 700 }}>{row.code}</td>
                      <td style={{ padding: "8px 10px" }}>{row.label}</td>
                      <td style={{ padding: "8px 10px" }}>{row.orderCount}</td>
                      <td style={{ padding: "8px 10px" }}>
                        <SignedMoney value={row.revenueTaxIncl} />
                      </td>
                      <td style={{ padding: "8px 10px", fontWeight: 800, color: "#1e40af" }}>
                        <SignedMoney value={row.kickbackOwed} />
                      </td>
                      <td style={{ padding: "8px 10px", color: "#047857" }}>
                        <SignedMoney value={row.kickbackPaid ?? 0} />
                      </td>
                      <td
                        style={{
                          padding: "8px 10px",
                          fontWeight: 700,
                          color: (row.kickbackOutstanding ?? row.kickbackOwed) > 0.009 ? "#b45309" : "#64748b"
                        }}
                      >
                        <SignedMoney value={row.kickbackOutstanding ?? row.kickbackOwed} />
                      </td>
                      <td style={{ padding: "8px 10px", fontSize: 13, whiteSpace: "nowrap" }}>
                        {row.lastKickbackPaidAt ? String(row.lastKickbackPaidAt).slice(0, 10) : "—"}
                      </td>
                      <td style={{ padding: "8px 10px", fontSize: 13, color: "#475569", maxWidth: 280 }}>
                        {row.payeeNotes || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ color: "#14532d" }}>Kickback payments (your books)</h3>
          <p style={{ fontSize: 13, color: "#64748b", marginTop: 0, maxWidth: 800 }}>
            Log each payout here. Rows are stored on the spreadsheet tab <strong>KickbackPayments</strong> (run the Apps Script <code>fix</code> once if the tab is missing). Promo code definitions stay in{" "}
            <strong>Settings → JR_PROMO_CODES_JSON</strong>; this ledger is only what you paid out.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 12,
              marginBottom: 16,
              padding: 16,
              border: "1px solid #e2e8f0",
              borderRadius: 10,
              background: "#f8fafc"
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Paid date (optional)
              <input
                type="date"
                value={kickbackPayForm.paidAt}
                onChange={(e) => setKickbackPayForm({ ...kickbackPayForm, paidAt: e.target.value })}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Period covered — from *
              <input
                type="date"
                required
                value={kickbackPayForm.periodFrom}
                onChange={(e) => setKickbackPayForm({ ...kickbackPayForm, periodFrom: e.target.value })}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Period covered — to *
              <input
                type="date"
                required
                value={kickbackPayForm.periodTo}
                onChange={(e) => setKickbackPayForm({ ...kickbackPayForm, periodTo: e.target.value })}
              />
            </label>
            <input
              placeholder="Promo code (match hub code, optional)"
              value={kickbackPayForm.promoCode}
              onChange={(e) => setKickbackPayForm({ ...kickbackPayForm, promoCode: e.target.value })}
              style={{ alignSelf: "end" }}
            />
            <input
              placeholder="Co-op / label (optional)"
              value={kickbackPayForm.promoLabel}
              onChange={(e) => setKickbackPayForm({ ...kickbackPayForm, promoLabel: e.target.value })}
              style={{ alignSelf: "end" }}
            />
            <input
              placeholder="Amount paid *"
              type="number"
              step="0.01"
              value={kickbackPayForm.amountPaid}
              onChange={(e) => setKickbackPayForm({ ...kickbackPayForm, amountPaid: e.target.value })}
              style={{ alignSelf: "end" }}
            />
            <textarea
              placeholder="Notes (Zelle ref, etc.)"
              value={kickbackPayForm.notes}
              onChange={(e) => setKickbackPayForm({ ...kickbackPayForm, notes: e.target.value })}
              rows={2}
              style={{ gridColumn: "1 / -1", fontFamily: "inherit" }}
            />
            <button
              type="button"
              style={{ padding: "10px 16px", fontWeight: 700, gridColumn: "1 / -1", justifySelf: "start" }}
              onClick={() =>
                void submit(async () => {
                  if (!kickbackPayForm.periodFrom || !kickbackPayForm.periodTo) throw new Error("Period from and to are required.");
                  const amt = Number(kickbackPayForm.amountPaid);
                  if (!(amt > 0)) throw new Error("Amount paid must be greater than zero.");
                  const paidAtIso = kickbackPayForm.paidAt
                    ? new Date(kickbackPayForm.paidAt + "T12:00:00").toISOString()
                    : undefined;
                  await apiPost("/operations/kickback-payments", {
                    paidAt: paidAtIso,
                    periodFrom: kickbackPayForm.periodFrom,
                    periodTo: kickbackPayForm.periodTo,
                    promoCode: kickbackPayForm.promoCode.trim() || undefined,
                    promoLabel: kickbackPayForm.promoLabel.trim() || undefined,
                    amountPaid: amt,
                    notes: kickbackPayForm.notes.trim() || undefined
                  });
                  const [cs, kb] = await Promise.all([
                    apiGet<any[]>("/operations/promo-codes/coop-summary"),
                    apiGet<any[]>("/operations/kickback-payments")
                  ]);
                  setCoopSummary(cs);
                  setKickbackPayments(kb);
                  setKickbackPayForm({
                    paidAt: "",
                    periodFrom: "",
                    periodTo: "",
                    promoCode: "",
                    promoLabel: "",
                    amountPaid: "",
                    notes: ""
                  });
                }, { title: "Record kickback payment" })
              }
            >
              Log payment
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: "#475569" }}>Filter ledger by paid date:</span>
            <input
              type="date"
              value={kickbackPaidFilter.from}
              onChange={(e) => setKickbackPaidFilter({ ...kickbackPaidFilter, from: e.target.value })}
            />
            <span style={{ color: "#94a3b8" }}>to</span>
            <input
              type="date"
              value={kickbackPaidFilter.to}
              onChange={(e) => setKickbackPaidFilter({ ...kickbackPaidFilter, to: e.target.value })}
            />
            <span style={{ fontSize: 13 }}>
              Filtered total:{" "}
              <strong>
                <SignedMoney value={sumKickbackPaid(filterKickbackPaymentsByPaidDate(kickbackPayments, kickbackPaidFilter.from, kickbackPaidFilter.to))} />
              </strong>
              {" · "}
              Lifetime paid:{" "}
              <strong>
                <SignedMoney value={sumKickbackPaid(kickbackPayments)} />
              </strong>
              {kickbackPayments.some((p) => !String(p.promoCode || "").trim()) ? (
                <>
                  {" · "}
                  Unallocated (no code):{" "}
                  <strong>
                    <SignedMoney
                      value={sumKickbackPaid(kickbackPayments.filter((p) => !String(p.promoCode || "").trim()))}
                    />
                  </strong>
                </>
              ) : null}
            </span>
          </div>
          {kickbackPayments.length === 0 ? (
            <p style={{ color: "#64748b", marginBottom: 24 }}>No kickback payments logged yet.</p>
          ) : (
            <div style={{ overflowX: "auto", marginBottom: 28 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "2px solid #cfe0d4" }}>
                    <th style={{ padding: "8px 10px" }}>Paid</th>
                    <th style={{ padding: "8px 10px" }}>Period</th>
                    <th style={{ padding: "8px 10px" }}>Code</th>
                    <th style={{ padding: "8px 10px" }}>Label</th>
                    <th style={{ padding: "8px 10px" }}>Amount</th>
                    <th style={{ padding: "8px 10px" }}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {filterKickbackPaymentsByPaidDate(kickbackPayments, kickbackPaidFilter.from, kickbackPaidFilter.to).map(
                    (p: any) => (
                      <tr key={p.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                        <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                          {String(p.paidAt || p.createdAt || "").slice(0, 10) || "—"}
                        </td>
                        <td style={{ padding: "8px 10px", whiteSpace: "nowrap", fontSize: 13 }}>
                          {p.periodFrom || "—"} → {p.periodTo || "—"}
                        </td>
                        <td style={{ padding: "8px 10px", fontWeight: 600 }}>{p.promoCode || "—"}</td>
                        <td style={{ padding: "8px 10px" }}>{p.promoLabel || "—"}</td>
                        <td style={{ padding: "8px 10px" }}>
                          <SignedMoney value={Number(p.amountPaid || 0)} />
                        </td>
                        <td style={{ padding: "8px 10px", fontSize: 13, color: "#475569", maxWidth: 260 }}>
                          {p.notes || "—"}
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ color: "#14532d" }}>All codes</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "2px solid #cfe0d4" }}>
                  <th style={{ padding: "8px 10px" }}>Code</th>
                  <th style={{ padding: "8px 10px" }}>Label</th>
                  <th style={{ padding: "8px 10px" }}>Type</th>
                  <th style={{ padding: "8px 10px" }}>Active</th>
                  <th style={{ padding: "8px 10px" }}>Discount % / $</th>
                  <th style={{ padding: "8px 10px" }}>Kickback % / $</th>
                  <th style={{ padding: "8px 10px" }} />
                </tr>
              </thead>
              <tbody>
                {promoCodes.map((p: any) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "8px 10px", fontWeight: 700 }}>{p.code}</td>
                    <td style={{ padding: "8px 10px" }}>{p.label}</td>
                    <td style={{ padding: "8px 10px" }}>{p.kind === "COOP" ? "Co-op" : "Coupon"}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <input
                        type="checkbox"
                        checked={Boolean(p.active)}
                        onChange={(e) =>
                          void submit(async () => {
                            await apiPut(`/operations/promo-codes/${p.id}`, { active: e.target.checked });
                            const pc = await apiGet<any[]>("/operations/promo-codes");
                            setPromoCodes(pc);
                          }, {
                            title: "Toggle promo code",
                            from: { code: p.code, active: p.active },
                            to: { code: p.code, active: e.target.checked }
                          })
                        }
                      />
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <>
                        {p.discountPercent != null ? <PctColored value={p.discountPercent} /> : "—"} /{" "}
                        {p.discountFixed != null ? <SignedMoney value={p.discountFixed} /> : "—"}
                      </>
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <>
                        {p.kickbackPercent != null ? <PctColored value={p.kickbackPercent} /> : "—"} /{" "}
                        {p.kickbackFixed != null ? <SignedMoney value={p.kickbackFixed} /> : "—"}
                      </>
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <button type="button" onClick={() => setEditingPromo({ ...p })}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {editingPromo ? (
            <div
              style={{
                marginTop: 20,
                padding: 16,
                border: "1px dashed #94a3b8",
                borderRadius: 10,
                background: "#f8fafc"
              }}
            >
              <h4 style={{ marginTop: 0 }}>Edit {editingPromo.code}</h4>
              <div style={{ display: "grid", gap: 10, maxWidth: 480 }}>
                <input
                  placeholder="Label"
                  value={editingPromo.label || ""}
                  onChange={(e) => setEditingPromo({ ...editingPromo, label: e.target.value })}
                />
                <textarea
                  placeholder="Payee notes"
                  value={editingPromo.payeeNotes || ""}
                  onChange={(e) => setEditingPromo({ ...editingPromo, payeeNotes: e.target.value })}
                  rows={2}
                  style={{ fontFamily: "inherit" }}
                />
                <input
                  placeholder="Discount % (pre-tax)"
                  type="number"
                  step="0.01"
                  value={editingPromo.discountPercent ?? ""}
                  onChange={(e) =>
                    setEditingPromo({
                      ...editingPromo,
                      discountPercent: e.target.value === "" ? null : Number(e.target.value)
                    })
                  }
                />
                <input
                  placeholder="Discount $ (pre-tax)"
                  type="number"
                  step="0.01"
                  value={editingPromo.discountFixed ?? ""}
                  onChange={(e) =>
                    setEditingPromo({
                      ...editingPromo,
                      discountFixed: e.target.value === "" ? null : Number(e.target.value)
                    })
                  }
                />
                <input
                  placeholder="Kickback % (pre-tax base)"
                  type="number"
                  step="0.01"
                  value={editingPromo.kickbackPercent ?? ""}
                  onChange={(e) =>
                    setEditingPromo({
                      ...editingPromo,
                      kickbackPercent: e.target.value === "" ? null : Number(e.target.value)
                    })
                  }
                />
                <input
                  placeholder="Kickback $ / order"
                  type="number"
                  step="0.01"
                  value={editingPromo.kickbackFixed ?? ""}
                  onChange={(e) =>
                    setEditingPromo({
                      ...editingPromo,
                      kickbackFixed: e.target.value === "" ? null : Number(e.target.value)
                    })
                  }
                />
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    type="button"
                    onClick={() =>
                      void submit(async () => {
                        await apiPut(`/operations/promo-codes/${editingPromo.id}`, {
                          label: editingPromo.label,
                          payeeNotes: editingPromo.payeeNotes?.trim() || null,
                          discountPercent: editingPromo.discountPercent ?? null,
                          discountFixed: editingPromo.discountFixed ?? null,
                          kickbackPercent: editingPromo.kickbackPercent ?? null,
                          kickbackFixed: editingPromo.kickbackFixed ?? null
                        });
                        const [pc, cs, kb] = await Promise.all([
                          apiGet<any[]>("/operations/promo-codes"),
                          apiGet<any[]>("/operations/promo-codes/coop-summary"),
                          apiGet<any[]>("/operations/kickback-payments")
                        ]);
                        setPromoCodes(pc);
                        setCoopSummary(cs);
                        setKickbackPayments(kb);
                        setEditingPromo(null);
                      }, {
                        title: "Update promo code",
                        from: editingPromo.code,
                        to: editingPromo.label
                      })
                    }
                  >
                    Save changes
                  </button>
                  <button type="button" onClick={() => setEditingPromo(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      )}

      {activeTab === "Notes" && (
        <section>
          <h2>Notes (Local Only)</h2>
          <p>Quick notes from JR Workers layout, stored only on this machine.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const text = noteInput.trim();
              if (!text) return;
              if (!(await confirmChange("Confirm note add", "No note", text))) return;
              setNotesList((prev) => [{ id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }, ...prev]);
              setNoteInput("");
            }}
          >
            <input placeholder="Write note..." value={noteInput} onChange={(e) => setNoteInput(e.target.value)} required style={{ minWidth: 360 }} />
            <button type="submit">Add Note</button>
          </form>
          <ul>
            {notesList.map((n) => (
              <li key={n.id}>
                {new Date(n.createdAt).toLocaleString()} - {n.text}
                <button
                  type="button"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    void (async () => {
                      if (!(await confirmChange("Confirm note delete", { note: n.text }, "Deleted"))) return;
                      setNotesList((prev) => prev.filter((x) => x.id !== n.id));
                    })();
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {activeTab === "Calendar" && (
        <section>
          <h2>Calendar</h2>
          <p style={{ maxWidth: 900, color: "#395946", lineHeight: 1.55 }}>
            <strong>Local</strong> events are saved in this browser (edit, reminders, done). <strong>JR Workers</strong>{" "}
            {jrWorkersCalendarAppsScriptConfigured() ? (
              <>
                talks to the same <strong>Google Calendar</strong> as <strong>JR Workers ACCES</strong> via your Apps Script web app URL in{" "}
                <code style={{ fontSize: 12 }}>NEXT_PUBLIC_JR_WORKERS_CALENDAR_APPS_SCRIPT_URL</code> — you can <strong>add, edit, and delete</strong> those events here.
              </>
            ) : (
              <>
                pulls every <code>.ics</code> file from your <strong>JR Workers ACCES</strong> folder on the Desktop (read-only). Set the env URL (same as JR Workers ACCES{" "}
                <code style={{ fontSize: 12 }}>src/api/calendar.js</code>) to use live Google Calendar instead.
              </>
            )}{" "}
            Use the source toggle for local only, workers only, or both. Click any row for a full preview (Esc to close).
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10, alignItems: "center" }}>
            <span style={{ fontWeight: 800, color: "#14532d", marginRight: 4 }}>Layout:</span>
            {(["month", "week"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  setCalendarView(v);
                  if (v === "month") setCalendarMonthPickDay(null);
                }}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: calendarView === v ? "2px solid #166534" : "1px solid #9ec1ac",
                  background: calendarView === v ? "#bbf7d0" : "#f7fbf8",
                  color: "#14532d",
                  fontWeight: 700,
                  textTransform: "capitalize"
                }}
              >
                {v}
              </button>
            ))}
            <span style={{ fontWeight: 800, color: "#14532d", marginLeft: 12, marginRight: 4 }}>Show:</span>
            {(
              [
                ["local", "My calendar"],
                ["workers", jrWorkersCalendarAppsScriptConfigured() ? "JR Workers (Google)" : "JR Workers (.ics)"],
                ["both", "Both"]
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setCalendarSourceMode(mode)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: calendarSourceMode === mode ? "2px solid #1d4ed8" : "1px solid #93c5fd",
                  background: calendarSourceMode === mode ? "#dbeafe" : "#f8fafc",
                  color: "#1e3a8a",
                  fontWeight: 700
                }}
              >
                {label}
              </button>
            ))}
            {(calendarSourceMode === "workers" || calendarSourceMode === "both") && (
              <button
                type="button"
                onClick={() => setWorkersIcsRefreshNonce((n) => n + 1)}
                disabled={workersIcsLoading}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1px solid #64748b",
                  background: "#fff",
                  color: "#334155",
                  fontWeight: 600,
                  opacity: workersIcsLoading ? 0.6 : 1
                }}
              >
                {workersIcsLoading ? "Refreshing…" : "Refresh JR Workers"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void Notification.requestPermission();
              }}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px solid #7c3aed",
                background: "#f5f3ff",
                color: "#5b21b6",
                fontWeight: 600
              }}
            >
              Enable browser reminders
            </button>
            <span style={{ fontSize: 12, color: "#64748b" }}>Reminders apply to local events only.</span>
          </div>

          {(calendarSourceMode === "workers" || calendarSourceMode === "both") && (
            <div
              style={{
                marginBottom: 12,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #bfdbfe",
                background: "#eff6ff",
                fontSize: 13,
                color: "#1e3a8a",
                maxWidth: 900
              }}
            >
              {workersIcsError ? (
                <strong style={{ color: "#b91c1c" }}>{workersIcsError}</strong>
              ) : workersIcsMeta ? (
                <>
                  {jrWorkersCalendarAppsScriptConfigured() ? (
                    <>
                      <strong>Source:</strong> {workersIcsMeta.pathTried}
                      {" · "}
                      <strong>Events in range:</strong> {workersIcsMeta.fileCount}
                    </>
                  ) : (
                    <>
                      <strong>ICS path:</strong> {workersIcsMeta.pathTried}
                      {" · "}
                      <strong>Files:</strong> {workersIcsMeta.fileCount}
                    </>
                  )}
                  {workersIcsMeta.warning ? (
                    <span style={{ display: "block", marginTop: 6, color: "#92400e", fontWeight: 600 }}>
                      {workersIcsMeta.warning}
                    </span>
                  ) : null}
                </>
              ) : (
                <span>Loading workers calendar…</span>
              )}
            </div>
          )}

          {jrWorkersCalendarAppsScriptConfigured() &&
            (calendarSourceMode === "workers" || calendarSourceMode === "both") && (
              <div
                style={{
                  border: "1px solid #93c5fd",
                  borderRadius: 14,
                  padding: 14,
                  background: "#fff",
                  marginBottom: 16,
                  maxWidth: 720
                }}
              >
                <h3 style={{ marginTop: 0, color: "#1e3a8a" }}>
                  {workersCalEditingId ? "Edit JR Workers calendar (Google)" : "Add JR Workers calendar (Google)"}
                </h3>
                <p style={{ marginTop: 0, fontSize: 13, color: "#475569" }}>
                  Same Apps Script web app as JR Workers ACCES (<code style={{ fontSize: 12 }}>src/api/calendar.js</code>). Tasks use a{" "}
                  <code>Task:</code> title prefix.
                </p>
                <form
                  style={{ display: "grid", gap: 10 }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const titleTrim = workersCalInput.title.trim();
                    if (!titleTrim) return;
                    if (!workersCalInput.whenStart || !workersCalInput.whenEnd) return;
                    if (new Date(workersCalInput.whenEnd) <= new Date(workersCalInput.whenStart)) return;
                    const finalTitle = workersCalInput.kind === "task" ? `Task: ${titleTrim}` : titleTrim;
                    const startISO = toISOFromLocalDatetimeInput(workersCalInput.whenStart);
                    const endISO = toISOFromLocalDatetimeInput(workersCalInput.whenEnd);
                    const loc = workersCalInput.location.trim();
                    const desc = workersCalInput.description.trim();
                    setWorkersCalSaving(true);
                    try {
                      if (workersCalEditingId) {
                        if (
                          !(await confirmChange("Save JR Workers calendar event", workersCalEditingId, {
                            title: finalTitle,
                            startISO,
                            endISO,
                            location: loc,
                            description: desc
                          }))
                        )
                          return;
                        await updateJrWorkersCalendarEvent(workersCalEditingId, {
                          title: finalTitle,
                          startISO,
                          endISO,
                          location: loc,
                          description: desc
                        });
                      } else {
                        if (
                          !(await confirmChange("Add JR Workers calendar event", "No event", {
                            title: finalTitle,
                            startISO,
                            endISO
                          }))
                        )
                          return;
                        await createJrWorkersCalendarEvent({
                          title: finalTitle,
                          startISO,
                          endISO,
                          location: loc,
                          description: desc
                        });
                      }
                      setWorkersCalEditingId(null);
                      setWorkersCalInput({
                        kind: "task",
                        title: "",
                        whenStart: localDateTimeValue(new Date()),
                        whenEnd: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)),
                        location: "",
                        description: ""
                      });
                      setWorkersIcsRefreshNonce((n) => n + 1);
                    } catch (err: any) {
                      window.alert(err?.message || "JR Workers calendar request failed");
                    } finally {
                      setWorkersCalSaving(false);
                    }
                  }}
                >
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                    Type
                    <select
                      value={workersCalInput.kind}
                      onChange={(e) =>
                        setWorkersCalInput({ ...workersCalInput, kind: e.target.value as "task" | "event" })
                      }
                      style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                    >
                      <option value="task">Task</option>
                      <option value="event">Event</option>
                    </select>
                  </label>
                  <input
                    placeholder="Name *"
                    value={workersCalInput.title}
                    onChange={(e) => setWorkersCalInput({ ...workersCalInput, title: e.target.value })}
                    required
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                      Start *
                      <input
                        type="datetime-local"
                        value={workersCalInput.whenStart}
                        onChange={(e) => setWorkersCalInput({ ...workersCalInput, whenStart: e.target.value })}
                        required
                        style={{ padding: "6px 8px", borderRadius: 8 }}
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                      End *
                      <input
                        type="datetime-local"
                        value={workersCalInput.whenEnd}
                        onChange={(e) => setWorkersCalInput({ ...workersCalInput, whenEnd: e.target.value })}
                        required
                        style={{ padding: "6px 8px", borderRadius: 8 }}
                      />
                    </label>
                  </div>
                  <input
                    placeholder="Location (optional)"
                    value={workersCalInput.location}
                    onChange={(e) => setWorkersCalInput({ ...workersCalInput, location: e.target.value })}
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                  />
                  <textarea
                    placeholder="Notes (optional)"
                    value={workersCalInput.description}
                    onChange={(e) => setWorkersCalInput({ ...workersCalInput, description: e.target.value })}
                    rows={3}
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", fontFamily: "inherit" }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button
                      type="submit"
                      disabled={workersCalSaving}
                      style={{
                        padding: "10px 18px",
                        borderRadius: 10,
                        border: "2px solid #1d4ed8",
                        background: "#93c5fd",
                        color: "#1e3a8a",
                        fontWeight: 700,
                        cursor: workersCalSaving ? "wait" : "pointer"
                      }}
                    >
                      {workersCalSaving ? "Saving…" : workersCalEditingId ? "Save changes" : "Create on Google Calendar"}
                    </button>
                    {workersCalEditingId ? (
                      <button
                        type="button"
                        onClick={() => {
                          setWorkersCalEditingId(null);
                          setWorkersCalInput({
                            kind: "task",
                            title: "",
                            whenStart: localDateTimeValue(new Date()),
                            whenEnd: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)),
                            location: "",
                            description: ""
                          });
                        }}
                        style={{
                          padding: "10px 18px",
                          borderRadius: 10,
                          border: "1px solid #64748b",
                          background: "#fff",
                          color: "#334155",
                          fontWeight: 600
                        }}
                      >
                        Cancel edit
                      </button>
                    ) : null}
                  </div>
                </form>
              </div>
            )}

          {calendarView === "week" && (
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                borderRadius: 12,
                border: "1px solid #cfe0d4",
                background: "#fafdfb",
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                alignItems: "center"
              }}
            >
              <span style={{ fontWeight: 700, color: "#14532d" }}>Week:</span>
              <button type="button" onClick={() => setCalendarWeekAnchor((d) => calendarAddDaysYmd(d, -7))}>
                ← Prev
              </button>
              <button type="button" onClick={() => setCalendarWeekAnchor(new Date().toISOString().slice(0, 10))}>
                This week
              </button>
              <button type="button" onClick={() => setCalendarWeekAnchor((d) => calendarAddDaysYmd(d, 7))}>
                Next →
              </button>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                Jump to
                <input type="date" value={calendarWeekAnchor} onChange={(e) => setCalendarWeekAnchor(e.target.value)} />
              </label>
              <span style={{ fontSize: 14, color: "#1f4d37", fontWeight: 600 }}>{calendarWeekLabel}</span>
            </div>
          )}

          {calendarView === "month" && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 10 }}>
                <label style={{ fontWeight: 700, color: "#14532d" }}>
                  Month{" "}
                  <input type="month" value={calendarMonth} onChange={(e) => { setCalendarMonth(e.target.value); setCalendarMonthPickDay(null); }} style={{ marginLeft: 6 }} />
                </label>
                {calendarMonthPickDay ? (
                  <button type="button" onClick={() => setCalendarMonthPickDay(null)} style={{ fontSize: 13 }}>
                    Show whole month ({calendarFilteredItems.length} in filter — clear day)
                  </button>
                ) : (
                  <span style={{ fontSize: 13, color: "#64748b" }}>Click a day in the grid to filter the list to that day.</span>
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                  gap: 4,
                  maxWidth: 720,
                  fontSize: 12
                }}
              >
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <div key={d} style={{ fontWeight: 800, color: "#166534", textAlign: "center", padding: 4 }}>
                    {d}
                  </div>
                ))}
                {(() => {
                  const parts = calendarMonth.split("-").map(Number);
                  const y = parts[0];
                  const m = parts[1];
                  if (!y || !m) return null;
                  const cells = calendarMonthGridCells(y, m - 1);
                  return cells.map((cell, idx) => {
                    if (!cell.ymd) {
                      return <div key={`e-${idx}`} style={{ minHeight: 52, background: "#f8fafc", borderRadius: 6 }} />;
                    }
                    const dayLocal = calendarEvents.filter((e) => e.date === cell.ymd);
                    const dayWorkers =
                      calendarSourceMode === "local" ? [] : workersIcs.filter((e) => e.date === cell.ymd);
                    const activeLocal = dayLocal.filter((e) => !e.done).length;
                    const sel = calendarMonthPickDay === cell.ymd;
                    const hasAny = dayLocal.length > 0 || dayWorkers.length > 0;
                    return (
                      <button
                        key={cell.ymd}
                        type="button"
                        onClick={() => setCalendarMonthPickDay(cell.ymd)}
                        style={{
                          minHeight: 52,
                          borderRadius: 8,
                          border: sel ? "2px solid #166534" : "1px solid #d1fae5",
                          background: sel ? "#d1fae5" : "#fff",
                          cursor: "pointer",
                          padding: 4,
                          textAlign: "left",
                          font: "inherit"
                        }}
                      >
                        <div style={{ fontWeight: 800, color: "#0f172a" }}>{cell.day}</div>
                        {hasAny ? (
                          <div style={{ fontSize: 10, color: activeLocal ? "#b45309" : "#64748b", lineHeight: 1.35 }}>
                            {calendarSourceMode !== "workers" && dayLocal.length > 0 ? (
                              <div>
                                {dayLocal.length} local{activeLocal ? ` · ${activeLocal} open` : ""}
                              </div>
                            ) : null}
                            {(calendarSourceMode === "workers" || calendarSourceMode === "both") && dayWorkers.length > 0 ? (
                              <div style={{ color: "#1d4ed8" }}>{dayWorkers.length} workers</div>
                            ) : null}
                          </div>
                        ) : (
                          <div style={{ fontSize: 10, color: "#cbd5e1" }}>—</div>
                        )}
                      </button>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {calendarSourceMode !== "workers" && (
          <div
            style={{
              border: "1px solid #cfe0d4",
              borderRadius: 14,
              padding: 14,
              background: "#fff",
              marginBottom: 16,
              maxWidth: 720
            }}
          >
            <h3 style={{ marginTop: 0, color: "#14532d" }}>Add event (local)</h3>
            <form
              style={{ display: "grid", gap: 10 }}
              onSubmit={async (e) => {
                e.preventDefault();
                const title = calendarInput.title.trim();
                if (!title || !calendarInput.date) return;
                let reminderAt = "";
                if (calendarInput.reminderAt.trim()) {
                  const rd = new Date(calendarInput.reminderAt);
                  if (!Number.isNaN(rd.getTime())) reminderAt = rd.toISOString();
                }
                const next: LocalCalendarEvent = {
                  id: crypto.randomUUID(),
                  title,
                  date: calendarInput.date,
                  note: calendarInput.note.trim(),
                  time: calendarInput.time.trim().slice(0, 5),
                  reminderAt,
                  done: false,
                  doneAt: ""
                };
                if (!(await confirmChange("Add calendar event", "No event", next))) return;
                setCalendarEvents((prev) => [...prev, next]);
                setCalendarInput({
                  title: "",
                  date: new Date().toISOString().slice(0, 10),
                  time: "",
                  note: "",
                  reminderAt: ""
                });
                calendarReminderFiredRef.current.delete(next.id);
              }}
            >
              <input
                placeholder="Title *"
                value={calendarInput.title}
                onChange={(e) => setCalendarInput({ ...calendarInput, title: e.target.value })}
                required
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
              />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                  Date *
                  <input
                    type="date"
                    value={calendarInput.date}
                    onChange={(e) => setCalendarInput({ ...calendarInput, date: e.target.value })}
                    required
                    style={{ padding: "6px 8px", borderRadius: 8 }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                  Time (optional)
                  <input
                    type="time"
                    value={calendarInput.time}
                    onChange={(e) => setCalendarInput({ ...calendarInput, time: e.target.value })}
                    style={{ padding: "6px 8px", borderRadius: 8 }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, flex: "1 1 200px" }}>
                  Reminder (optional)
                  <input
                    type="datetime-local"
                    value={calendarInput.reminderAt}
                    onChange={(e) => setCalendarInput({ ...calendarInput, reminderAt: e.target.value })}
                    style={{ padding: "6px 8px", borderRadius: 8 }}
                  />
                </label>
              </div>
              <textarea
                placeholder="Notes / details"
                value={calendarInput.note}
                onChange={(e) => setCalendarInput({ ...calendarInput, note: e.target.value })}
                rows={2}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", fontFamily: "inherit" }}
              />
              <button
                type="submit"
                style={{
                  justifySelf: "start",
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: "2px solid #166534",
                  background: "#86efac",
                  color: "#14532d",
                  fontWeight: 700,
                  cursor: "pointer"
                }}
              >
                Add to calendar
              </button>
            </form>
          </div>
          )}

          <h3 style={{ color: "#14532d" }}>
            {calendarView === "week" && `Events this week (${calendarFilteredItems.length})`}
            {calendarView === "month" &&
              `Events — ${calendarMonth}${calendarMonthPickDay ? ` · ${calendarMonthPickDay}` : ""} (${calendarFilteredItems.length})`}
          </h3>

          {calendarFilteredItems.length === 0 ? (
            <p style={{ color: "#64748b" }}>
              {calendarSourceMode === "workers" && workersIcsError
                ? jrWorkersCalendarAppsScriptConfigured()
                  ? "Could not load JR Workers Google Calendar — check the Apps Script URL in .env.local and your network."
                  : "Could not load JR Workers .ics — check the path message above and that the API is running."
                : "No events in this view. Add a local event, switch source to Workers or Both, or change the week/month (or clear the day filter)."}
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              {calendarFilteredItems.map((item) => {
                if (item.source === "workers") {
                  const ev = item.event;
                  return (
                    <li
                      key={ev.id}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("button, a, input, textarea, select, label")) return;
                        setCalendarPreviewItem(item);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setCalendarPreviewItem(item);
                        }
                      }}
                      style={{
                        borderRadius: 14,
                        border: "1px solid #93c5fd",
                        padding: 14,
                        background: "#eff6ff",
                        cursor: "pointer",
                        boxShadow: "0 2px 8px rgba(29, 78, 216, 0.08)"
                      }}
                    >
                      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                        <div style={{ flex: "1 1 220px" }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: "#1d4ed8", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {ev.workersRemote === "apps-script" ? "JR Workers (Google Calendar)" : "JR Workers (.ics read-only)"}
                          </div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", marginTop: 4 }}>{ev.title}</div>
                          <div style={{ marginTop: 6, fontSize: 14, color: "#1e40af" }}>
                            <strong>{ev.date}</strong>
                            {ev.allDay ? " · All day" : ev.time ? ` · ${ev.time}` : ""}
                          </div>
                          {ev.location ? (
                            <div style={{ marginTop: 6, fontSize: 13, color: "#334155" }}>Location: {ev.location}</div>
                          ) : null}
                          {ev.description ? (
                            <div style={{ marginTop: 8, fontSize: 13, color: "#475569", whiteSpace: "pre-wrap", maxHeight: 72, overflow: "hidden" }}>
                              {ev.description}
                            </div>
                          ) : null}
                          {ev.workersRemote === "ics" ? (
                            <div style={{ marginTop: 8, fontSize: 11, color: "#64748b" }}>File: {ev.sourceFile}</div>
                          ) : (
                            <div style={{ marginTop: 8, fontSize: 11, color: "#64748b" }}>Source: {ev.sourceFile}</div>
                          )}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "stretch" }}>
                          <button
                            type="button"
                            onClick={() => setCalendarPreviewItem(item)}
                            style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #1d4ed8", background: "#fff", color: "#1e3a8a", fontWeight: 700 }}
                          >
                            Open details
                          </button>
                          {ev.workersRemote === "apps-script" ? (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              <button
                                type="button"
                                onClick={() => {
                                  const rawTitle = ev.title?.startsWith("Task: ")
                                    ? ev.title.replace(/^Task:\s*/i, "").trim()
                                    : (ev.title || "");
                                  setWorkersCalEditingId(ev.id);
                                  setWorkersCalInput({
                                    kind: ev.title?.startsWith("Task: ") ? "task" : "event",
                                    title: rawTitle,
                                    whenStart: localDateTimeValue(new Date(ev.start)),
                                    whenEnd: localDateTimeValue(new Date(ev.end)),
                                    location: ev.location || "",
                                    description: ev.description || ""
                                  });
                                }}
                                style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #64748b", background: "#f8fafc", fontWeight: 600 }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  void (async () => {
                                    if (!(await confirmChange("Delete JR Workers calendar event", ev, "Deleted"))) return;
                                    try {
                                      await deleteJrWorkersCalendarEvent(ev.id);
                                      setWorkersIcsRefreshNonce((n) => n + 1);
                                      setCalendarPreviewItem((cur) =>
                                        cur?.source === "workers" && cur.event.id === ev.id ? null : cur
                                      );
                                      if (workersCalEditingId === ev.id) {
                                        setWorkersCalEditingId(null);
                                        setWorkersCalInput({
                                          kind: "task",
                                          title: "",
                                          whenStart: localDateTimeValue(new Date()),
                                          whenEnd: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)),
                                          location: "",
                                          description: ""
                                        });
                                      }
                                    } catch (err: any) {
                                      window.alert(err?.message || "Delete failed");
                                    }
                                  })();
                                }}
                                style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", fontWeight: 600 }}
                              >
                                Delete
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                }
                const ev = item.event;
                const editing = calendarEditingId === ev.id;
                const isoToLocalInput = (iso: string) => {
                  if (!iso) return "";
                  const d = new Date(iso);
                  if (Number.isNaN(d.getTime())) return "";
                  const p = (n: number) => String(n).padStart(2, "0");
                  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
                };
                return (
                  <li
                    key={ev.id}
                    onClick={(e) => {
                      if (editing) return;
                      if ((e.target as HTMLElement).closest("button, a, input, textarea, select, label")) return;
                      setCalendarPreviewItem(item);
                    }}
                    style={{
                      borderRadius: 14,
                      border: ev.done ? "1px solid #cbd5e1" : "1px solid #86efac",
                      padding: 14,
                      background: ev.done ? "#e2e8f0" : "#f0fdf4",
                      opacity: ev.done ? 0.72 : 1,
                      filter: ev.done ? "grayscale(0.25)" : undefined,
                      boxShadow: ev.done ? "none" : "0 2px 8px rgba(22, 101, 52, 0.06)",
                      cursor: editing ? "default" : "pointer"
                    }}
                  >
                    {editing ? (
                      <div style={{ display: "grid", gap: 10 }}>
                        <input
                          value={calendarEditDraft.title}
                          onChange={(e) => setCalendarEditDraft({ ...calendarEditDraft, title: e.target.value })}
                          style={{ padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                        />
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          <input
                            type="date"
                            value={calendarEditDraft.date}
                            onChange={(e) => setCalendarEditDraft({ ...calendarEditDraft, date: e.target.value })}
                          />
                          <input
                            type="time"
                            value={calendarEditDraft.time}
                            onChange={(e) => setCalendarEditDraft({ ...calendarEditDraft, time: e.target.value })}
                          />
                          <input
                            type="datetime-local"
                            value={calendarEditDraft.reminderAt}
                            onChange={(e) => setCalendarEditDraft({ ...calendarEditDraft, reminderAt: e.target.value })}
                            style={{ flex: "1 1 200px" }}
                          />
                        </div>
                        <textarea
                          value={calendarEditDraft.note}
                          onChange={(e) => setCalendarEditDraft({ ...calendarEditDraft, note: e.target.value })}
                          rows={2}
                          style={{ padding: 8, borderRadius: 8, fontFamily: "inherit" }}
                        />
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            onClick={() => {
                              void (async () => {
                                let reminderAt = "";
                                if (calendarEditDraft.reminderAt.trim()) {
                                  const rd = new Date(calendarEditDraft.reminderAt);
                                  if (!Number.isNaN(rd.getTime())) reminderAt = rd.toISOString();
                                }
                                const updated = {
                                  ...ev,
                                  title: calendarEditDraft.title.trim(),
                                  date: calendarEditDraft.date,
                                  time: calendarEditDraft.time.trim().slice(0, 5),
                                  note: calendarEditDraft.note.trim(),
                                  reminderAt
                                };
                                if (!(await confirmChange("Save calendar event", ev, updated))) return;
                                setCalendarEvents((prev) => prev.map((x) => (x.id === ev.id ? updated : x)));
                                calendarReminderFiredRef.current.delete(ev.id);
                                setCalendarEditingId(null);
                              })();
                            }}
                            style={{ padding: "8px 14px", borderRadius: 8, fontWeight: 700, background: "#86efac", border: "1px solid #166534", color: "#14532d" }}
                          >
                            Save
                          </button>
                          <button type="button" onClick={() => setCalendarEditingId(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                          <div style={{ flex: "1 1 200px" }}>
                            <div
                              style={{
                                fontSize: 18,
                                fontWeight: 800,
                                color: "#0f172a",
                                textDecoration: ev.done ? "line-through" : undefined
                              }}
                            >
                              {ev.title}
                            </div>
                            <div style={{ marginTop: 6, fontSize: 14, color: "#1f4d37" }}>
                              <strong>{ev.date}</strong>
                              {ev.time ? ` · ${ev.time}` : ""}
                              {ev.done && ev.doneAt ? (
                                <span style={{ marginLeft: 8, fontSize: 12, color: "#64748b" }}>
                                  · Done {new Date(ev.doneAt).toLocaleString()}
                                </span>
                              ) : null}
                            </div>
                            {ev.note ? (
                              <div
                                style={{
                                  marginTop: 8,
                                  fontSize: 14,
                                  color: "#334155",
                                  whiteSpace: "pre-wrap",
                                  textDecoration: ev.done ? "line-through" : undefined
                                }}
                              >
                                {ev.note}
                              </div>
                            ) : null}
                            {ev.reminderAt ? (
                              <div style={{ marginTop: 8, fontSize: 12, color: "#5b21b6", fontWeight: 600 }}>
                                Reminder: {new Date(ev.reminderAt).toLocaleString()}
                              </div>
                            ) : null}
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                            {!ev.done ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setCalendarEvents((prev) =>
                                    prev.map((x) =>
                                      x.id === ev.id
                                        ? { ...x, done: true, doneAt: new Date().toISOString() }
                                        : x
                                    )
                                  );
                                }}
                                style={{
                                  padding: "8px 12px",
                                  borderRadius: 10,
                                  border: "2px solid #166534",
                                  background: "#86efac",
                                  color: "#14532d",
                                  fontWeight: 800,
                                  cursor: "pointer"
                                }}
                              >
                                Yes, did it
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setCalendarEvents((prev) =>
                                    prev.map((x) => (x.id === ev.id ? { ...x, done: false, doneAt: "" } : x))
                                  );
                                  calendarReminderFiredRef.current.delete(ev.id);
                                }}
                                style={{
                                  padding: "8px 12px",
                                  borderRadius: 10,
                                  border: "1px solid #64748b",
                                  background: "#fff",
                                  color: "#334155",
                                  fontWeight: 600
                                }}
                              >
                                Mark not done
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setCalendarEditingId(ev.id);
                                setCalendarEditDraft({
                                  title: ev.title,
                                  date: ev.date,
                                  time: ev.time || "",
                                  note: ev.note || "",
                                  reminderAt: isoToLocalInput(ev.reminderAt || "")
                                });
                              }}
                              style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #9ec1ac", background: "#fff" }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void (async () => {
                                  if (!(await confirmChange("Delete calendar event", ev, "Deleted"))) return;
                                  setCalendarEvents((prev) => prev.filter((x) => x.id !== ev.id));
                                  calendarReminderFiredRef.current.delete(ev.id);
                                  if (calendarEditingId === ev.id) setCalendarEditingId(null);
                                })();
                              }}
                              style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b" }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        {ev.done ? (
                          <div
                            style={{
                              marginTop: 10,
                              fontSize: 12,
                              fontWeight: 700,
                              color: "#475569",
                              textTransform: "uppercase",
                              letterSpacing: "0.06em"
                            }}
                          >
                            Completed — kept for your records
                          </div>
                        ) : null}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {activeTab === "Calculator" && (
        <section style={{ maxWidth: 920 }}>
          <h2>Calculator &amp; Google Sheets formulas</h2>
          <p style={{ lineHeight: 1.5 }}>
            One place for NJ tax math, P&amp;L notes, and sample Sheets formulas. Data comes from{" "}
            <code style={{ fontSize: 13 }}>GET {getPublicApiBase()}/reports/calculator</code> (same auth as the rest of the hub).
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
            <button
              type="button"
              onClick={() =>
                void downloadWithAuth(`${getPublicApiBase()}/reports/calculator/sheet-template.csv`, "hub-calculator-formulas-template.csv")
              }
              style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #166534", background: "#bbf7d0", fontWeight: 700, cursor: "pointer" }}
            >
              Download formula template (.csv)
            </button>
            <button
              type="button"
              onClick={() => void refreshActiveTabData("Calculator")}
              style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #9ec1ac", background: "#f7fbf8", cursor: "pointer" }}
            >
              Refresh reference
            </button>
          </div>
          <p style={{ fontSize: 13, color: "#64748b" }}>
            Open the CSV in Google Sheets and replace column letters (<code>M2</code>, etc.) with your Archive/Products layout. For full product cost/lb, use the Apps Script in{" "}
            <code>apps-script/jr-sheet-controller</code> or paste the patterns below.
          </p>
          {!calculatorData ? (
            <p style={{ color: "#64748b" }}>Loading…</p>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              {calculatorData.hubPnlNote ? (
                <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, background: "#f8fafc" }}>
                  <h3 style={{ marginTop: 0, fontSize: 15 }}>Books P&amp;L</h3>
                  <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{String(calculatorData.hubPnlNote)}</p>
                </div>
              ) : null}
              {calculatorData.customerMetrics ? (
                <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12 }}>
                  <h3 style={{ marginTop: 0, fontSize: 15 }}>Customer averages (vs product-mix table)</h3>
                  <p style={{ margin: "0 0 8px", fontSize: 14, lineHeight: 1.5 }}>
                    <strong>Avg profit / customer:</strong> {String(calculatorData.customerMetrics?.avgProfitPerCustomer ?? "")}
                  </p>
                  <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
                    <strong>Avg of each customer’s profit/lb:</strong> {String(calculatorData.customerMetrics?.avgCustomerBlendedProfitPerLb ?? "")}
                  </p>
                </div>
              ) : null}
              {Array.isArray(calculatorData.googleSheets_formulas) && calculatorData.googleSheets_formulas.length > 0 ? (
                <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12 }}>
                  <h3 style={{ marginTop: 0, fontSize: 15 }}>Sample Google Sheets formulas</h3>
                  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55, fontSize: 13 }}>
                    {calculatorData.googleSheets_formulas.map((f: any) => (
                      <li key={String(f.id)} style={{ marginBottom: 10 }}>
                        <div style={{ fontWeight: 700 }}>{String(f.description || f.id)}</div>
                        {f.formula ? (
                          <code style={{ display: "block", marginTop: 4, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{String(f.formula)}</code>
                        ) : null}
                        {f.example ? (
                          <div style={{ marginTop: 4, fontSize: 12, color: "#475569" }}>
                            Example: <code>{String(f.example)}</code>
                          </div>
                        ) : null}
                        {f.notes ? <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>{String(f.notes)}</div> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {calculatorData.archiveImport ? (
                <div style={{ border: "1px solid #fef3c7", borderRadius: 10, padding: 12, background: "#fffbeb" }}>
                  <h3 style={{ marginTop: 0, fontSize: 15 }}>Legacy archive import</h3>
                  <p style={{ margin: "0 0 8px", fontSize: 14, lineHeight: 1.5 }}>{String(calculatorData.archiveImport.recommendation ?? "")}</p>
                  <p style={{ margin: 0, fontSize: 13, color: "#92400e" }}>
                    Python: <code>python scripts/build_archive_from_jersey_orders.py</code> (default: no legacy profit columns). Add{" "}
                    <code>--legacy-profit-columns</code> only if you intentionally want old spreadsheet profit copied.
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </section>
      )}

      {activeTab === "Reports" && (
        <section>
          <h2>Range Reports</h2>
          <p>Pick week, month, or custom dates to see clean totals for sales, tax, expenses, profit, and item-level counts.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(140px, 1fr))", gap: 8, marginBottom: 12, maxWidth: 980 }}>
            <select value={reportPreset} onChange={(e) => setReportPreset(e.target.value as "week" | "month" | "custom")}>
              <option value="week">This week (last 7 days)</option>
              <option value="month">This month (to date)</option>
              <option value="custom">Custom range</option>
            </select>
            <input
              type="date"
              value={reportRange.from}
              disabled={reportPreset !== "custom"}
              onChange={(e) => setReportRange((prev) => ({ ...prev, from: e.target.value }))}
              title="From date"
            />
            <input
              type="date"
              value={reportRange.to}
              disabled={reportPreset !== "custom"}
              onChange={(e) => setReportRange((prev) => ({ ...prev, to: e.target.value }))}
              title="To date"
            />
            <button type="button" onClick={() => setReportPreset("week")}>
              Quick Week
            </button>
            <button type="button" onClick={() => setReportPreset("month")}>
              Quick Month
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10, marginBottom: 12 }}>
            {[
              { label: "Sales (tax incl.)", node: <SignedMoney value={reportSummary.orderTotals.salesTaxIncl} /> },
              { label: "Net sales", node: <SignedMoney value={reportSummary.orderTotals.netSales} /> },
              { label: "Sales tax collected", node: <SignedMoney value={reportSummary.orderTotals.taxCollected} /> },
              { label: "COGS", node: <SignedMoney value={reportSummary.orderTotals.cogs} /> },
              { label: "Gross profit", node: <SignedMoney value={reportSummary.orderTotals.profit} /> },
              { label: "Expenses", node: <SignedMoney value={reportSummary.expenseTotal} /> },
              { label: "Net profit", node: <SignedMoney value={reportSummary.netAfterExpenses} /> },
              { label: "Orders (active)", node: <span>{reportSummary.orderTotals.orders}</span> },
              { label: "Cancelled orders", node: <span>{reportSummary.cancelledOrderCount}</span> },
              { label: "Total lbs sold", node: <span>{reportSummary.orderTotals.lbs.toFixed(2)}</span> },
              { label: "Avg order value", node: <SignedMoney value={reportSummary.avgOrderValue} /> },
              { label: "Profit / lb", node: <SignedMoney value={reportSummary.profitPerLb} /> },
              { label: "Gross margin %", node: <PctColored value={reportSummary.marginPct} /> },
              { label: "Expense ratio %", node: <PctColored value={reportSummary.expenseRatioPct} /> },
              {
                label: "Top customer",
                node: reportSummary.topCustomer ? (
                  <span style={{ fontSize: 12 }}>
                    {reportSummary.topCustomer[0]} (<SignedMoney value={reportSummary.topCustomer[1]} />)
                  </span>
                ) : (
                  <span>—</span>
                )
              }
            ].map((card) => (
              <div key={card.label} style={{ border: "1px solid #d4e4d9", borderRadius: 10, padding: 10, background: "#f7fbf8" }}>
                <div style={{ fontSize: 11, color: "#4d6a58", textTransform: "uppercase", letterSpacing: "0.03em" }}>{card.label}</div>
                <div style={{ marginTop: 6, fontWeight: 700 }}>{card.node}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 1fr) minmax(340px, 1.5fr)", gap: 12, alignItems: "start" }}>
            <div style={{ border: "1px solid #d4e4d9", borderRadius: 10, padding: 12, background: "#fff" }}>
              <h3 style={{ marginTop: 0 }}>Expenses by Category</h3>
              <p style={{ marginTop: 0, fontSize: 13 }}>
                Records: {reportSummary.expenseCount} | Total: <SignedMoney value={reportSummary.expenseTotal} />
              </p>
              {reportSummary.expenseByCategory.length === 0 ? (
                <p style={{ margin: 0 }}>No expenses in this range.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {reportSummary.expenseByCategory.map((row: any) => (
                    <li key={row.category}>
                      {row.category}: <SignedMoney value={row.total} />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div style={{ border: "1px solid #d4e4d9", borderRadius: 10, padding: 12, background: "#fff", overflowX: "auto" }}>
              <h3 style={{ marginTop: 0 }}>Item Breakdown (How many of each item)</h3>
              {reportSummary.items.length === 0 ? (
                <p style={{ margin: 0 }}>No order items in this range.</p>
              ) : (
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ border: "1px solid #ccc", padding: 6, textAlign: "left" }}>Item</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Orders</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Lbs</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Sales (tax incl.)</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Net sales</th>
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportSummary.items.map((row: any) => (
                      <tr key={row.item}>
                        <td style={{ border: "1px solid #ccc", padding: 6 }}>{row.item}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6, textAlign: "center" }}>{row.orders}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6, textAlign: "center" }}>{row.lbs.toFixed(2)}</td>
                        <td style={{ border: "1px solid #ccc", padding: 6, textAlign: "right" }}><SignedMoney value={row.salesTaxIncl} /></td>
                        <td style={{ border: "1px solid #ccc", padding: 6, textAlign: "right" }}><SignedMoney value={row.netSales} /></td>
                        <td style={{ border: "1px solid #ccc", padding: 6, textAlign: "right" }}><SignedMoney value={row.profit} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <h3 style={{ marginBottom: 6 }}>CSV Exports</h3>
          <p style={{ marginTop: 0, fontSize: 13 }}>Use these downloads for accountant-ready raw detail exports.</p>
          <ul>
            <li>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await downloadWithAuth(`${getPublicApiBase()}/reports/expenses.csv`, "expenses.csv");
                  } catch (e: any) {
                    alert(e?.message || "Download failed.");
                  }
                }}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--forest-700, #2c6a49)",
                  textDecoration: "underline",
                  cursor: "pointer",
                  font: "inherit",
                  fontWeight: 600
                }}
              >
                Download Expenses CSV
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await downloadWithAuth(`${getPublicApiBase()}/reports/orders.csv`, "orders.csv");
                  } catch (e: any) {
                    alert(e?.message || "Download failed.");
                  }
                }}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--forest-700, #2c6a49)",
                  textDecoration: "underline",
                  cursor: "pointer",
                  font: "inherit",
                  fontWeight: 600
                }}
              >
                Download Orders CSV
              </button>
            </li>
          </ul>
        </section>
      )}

    </main>

      {dashboardDrillModalEl}

      {calendarPreviewItem && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="calendar-preview-title"
          onClick={() => setCalendarPreviewItem(null)}
          onWheel={preventModalBackdropWheel}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            background: "rgba(15, 46, 32, 0.48)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            overscrollBehavior: "contain",
            touchAction: "none"
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              maxHeight: "min(88vh, 640px)",
              display: "flex",
              flexDirection: "column",
              borderRadius: 16,
              overflow: "hidden",
              boxShadow: "0 24px 48px rgba(31, 77, 55, 0.35)",
              border: "1px solid #9ec1ac",
              background: "#fff",
              touchAction: "auto",
              overscrollBehavior: "contain"
            }}
          >
            <div
              style={{
                background:
                  calendarPreviewItem.source === "workers"
                    ? "linear-gradient(135deg, #bfdbfe, #dbeafe)"
                    : "linear-gradient(135deg, #bbf7d0, #d1fae5)",
                color: "#14532d",
                padding: "16px 20px",
                borderBottom: "1px solid #6ee7b7"
              }}
            >
              <h2 id="calendar-preview-title" style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#0f172a" }}>
                {calendarPreviewItem.source === "workers" ? "JR Workers event" : "Local event"}
              </h2>
              <p style={{ margin: "8px 0 0", fontSize: 13, color: calendarPreviewItem.source === "workers" ? "#1e40af" : "#166534" }}>
                Click outside or press Esc to close.
              </p>
            </div>
            <div style={{ padding: 18, overflowY: "auto", flex: 1, background: "#fafdfb" }}>
              {calendarPreviewItem.source === "workers" ? (
                <>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#0f172a" }}>{calendarPreviewItem.event.title}</div>
                  <div style={{ marginTop: 10, fontSize: 15, color: "#1e293b" }}>
                    <strong>{calendarPreviewItem.event.date}</strong>
                    {calendarPreviewItem.event.allDay
                      ? " · All day"
                      : calendarPreviewItem.event.time
                        ? ` · ${calendarPreviewItem.event.time}`
                        : ""}
                  </div>
                  {calendarPreviewItem.event.start ? (
                    <div style={{ marginTop: 8, fontSize: 13, color: "#64748b" }}>
                      Start: {new Date(calendarPreviewItem.event.start).toLocaleString()}
                      {calendarPreviewItem.event.end
                        ? ` · End: ${new Date(calendarPreviewItem.event.end).toLocaleString()}`
                        : ""}
                    </div>
                  ) : null}
                  {calendarPreviewItem.event.location ? (
                    <div style={{ marginTop: 12, fontSize: 14, color: "#334155" }}>
                      <strong>Location</strong>
                      <div style={{ whiteSpace: "pre-wrap" }}>{calendarPreviewItem.event.location}</div>
                    </div>
                  ) : null}
                  {calendarPreviewItem.event.description ? (
                    <div style={{ marginTop: 12, fontSize: 14, color: "#334155" }}>
                      <strong>Description</strong>
                      <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{calendarPreviewItem.event.description}</div>
                    </div>
                  ) : null}
                  {calendarPreviewItem.event.workersRemote === "ics" ? (
                    <div style={{ marginTop: 14, fontSize: 12, color: "#64748b" }}>
                      UID: {calendarPreviewItem.event.uid}
                      <br />
                      File: {calendarPreviewItem.event.sourceFile}
                    </div>
                  ) : (
                    <div style={{ marginTop: 14, fontSize: 12, color: "#64748b" }}>Source: {calendarPreviewItem.event.sourceFile}</div>
                  )}
                  {calendarPreviewItem.event.workersRemote === "apps-script" ? (
                    <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => {
                          const ev = calendarPreviewItem.event;
                          const rawTitle = ev.title?.startsWith("Task: ")
                            ? ev.title.replace(/^Task:\s*/i, "").trim()
                            : (ev.title || "");
                          setWorkersCalEditingId(ev.id);
                          setWorkersCalInput({
                            kind: ev.title?.startsWith("Task: ") ? "task" : "event",
                            title: rawTitle,
                            whenStart: localDateTimeValue(new Date(ev.start)),
                            whenEnd: localDateTimeValue(new Date(ev.end)),
                            location: ev.location || "",
                            description: ev.description || ""
                          });
                          setCalendarPreviewItem(null);
                        }}
                        style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #64748b", background: "#fff", fontWeight: 700 }}
                      >
                        Edit in form
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const ev = calendarPreviewItem.event;
                          void (async () => {
                            if (!(await confirmChange("Delete JR Workers calendar event", ev, "Deleted"))) return;
                            try {
                              await deleteJrWorkersCalendarEvent(ev.id);
                              setCalendarPreviewItem(null);
                              setWorkersIcsRefreshNonce((n) => n + 1);
                              if (workersCalEditingId === ev.id) {
                                setWorkersCalEditingId(null);
                                setWorkersCalInput({
                                  kind: "task",
                                  title: "",
                                  whenStart: localDateTimeValue(new Date()),
                                  whenEnd: localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000)),
                                  location: "",
                                  description: ""
                                });
                              }
                            } catch (err: any) {
                              window.alert(err?.message || "Delete failed");
                            }
                          })();
                        }}
                        style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #fecaca", background: "#fef2f2", color: "#991b1b", fontWeight: 700 }}
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 800,
                      color: "#0f172a",
                      textDecoration: calendarPreviewItem.event.done ? "line-through" : undefined
                    }}
                  >
                    {calendarPreviewItem.event.title}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 15, color: "#1e293b" }}>
                    <strong>{calendarPreviewItem.event.date}</strong>
                    {calendarPreviewItem.event.time ? ` · ${calendarPreviewItem.event.time}` : ""}
                    {calendarPreviewItem.event.done && calendarPreviewItem.event.doneAt ? (
                      <span style={{ marginLeft: 8, fontSize: 13, color: "#64748b" }}>
                        · Done {new Date(calendarPreviewItem.event.doneAt).toLocaleString()}
                      </span>
                    ) : null}
                  </div>
                  {calendarPreviewItem.event.note ? (
                    <div style={{ marginTop: 12, fontSize: 14, color: "#334155", whiteSpace: "pre-wrap" }}>
                      {calendarPreviewItem.event.note}
                    </div>
                  ) : null}
                  {calendarPreviewItem.event.reminderAt ? (
                    <div style={{ marginTop: 12, fontSize: 13, color: "#5b21b6", fontWeight: 600 }}>
                      Reminder: {new Date(calendarPreviewItem.event.reminderAt).toLocaleString()}
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div style={{ padding: "12px 16px", borderTop: "1px solid #e2e8f0", background: "#fff", display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setCalendarPreviewItem(null)}
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: "2px solid #166534",
                  background: "#86efac",
                  color: "#14532d",
                  fontWeight: 700,
                  cursor: "pointer"
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-modal-title"
          onClick={() => resolveConfirm(false)}
          onWheel={preventModalBackdropWheel}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            background: "rgba(15, 46, 32, 0.48)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            overscrollBehavior: "contain",
            touchAction: "none"
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 560,
              maxHeight: "min(88vh, 720px)",
              display: "flex",
              flexDirection: "column",
              borderRadius: 16,
              overflow: "hidden",
              boxShadow: "0 24px 48px rgba(31, 77, 55, 0.35)",
              border: "1px solid #9ec1ac",
              background: "#fff",
              touchAction: "auto",
              overscrollBehavior: "contain"
            }}
          >
            <div
              style={{
                background: "linear-gradient(135deg, #bbf7d0, #d1fae5)",
                color: "#14532d",
                padding: "16px 20px",
                borderBottom: "1px solid #6ee7b7"
              }}
            >
              <h2 id="confirm-modal-title" style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
                {confirmModal.title}
              </h2>
              <p style={{ margin: "8px 0 0", fontSize: 13, color: "#166534" }}>
                Read what will change, then confirm or cancel.
              </p>
            </div>
            <div style={{ padding: 16, overflowY: "auto", flex: 1, background: "#fafdfb" }}>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: "#64748b", marginBottom: 8 }}>
                  What you have saved now
                </div>
                <div
                  style={{
                    margin: 0,
                    padding: 14,
                    borderRadius: 10,
                    background: "#fff",
                    border: "1px solid #e2e8f0",
                    fontSize: 14,
                    lineHeight: 1.55,
                    color: "#1e293b",
                    fontFamily: 'system-ui, "Segoe UI", sans-serif'
                  }}
                >
                  {formatConfirmHumanLines(confirmModal.from).map((line, i) => (
                    <div key={i} style={{ marginBottom: 4 }}>
                      {line}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: "#166534", marginBottom: 8 }}>
                  What will be applied next
                </div>
                <div
                  style={{
                    margin: 0,
                    padding: 14,
                    borderRadius: 10,
                    background: "#ecfdf5",
                    border: "1px solid #a7f3d0",
                    fontSize: 14,
                    lineHeight: 1.55,
                    color: "#14532d",
                    fontFamily: 'system-ui, "Segoe UI", sans-serif'
                  }}
                >
                  {formatConfirmHumanLines(confirmModal.to).map((line, i) => (
                    <div key={i} style={{ marginBottom: 4 }}>
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
                padding: "12px 16px",
                borderTop: "1px solid #d8ebe0",
                background: "#f7fbf8"
              }}
            >
              <button
                type="button"
                onClick={() => resolveConfirm(false)}
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: "1px solid #9ec1ac",
                  background: "#fff",
                  color: "#1f4d37",
                  fontWeight: 600,
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => resolveConfirm(true)}
                style={{
                  padding: "10px 18px",
                  borderRadius: 10,
                  border: "2px solid #166534",
                  background: "#86efac",
                  color: "#14532d",
                  fontWeight: 700,
                  cursor: "pointer",
                  boxShadow: "0 2px 8px rgba(22, 101, 52, 0.2)"
                }}
              >
                Yes, apply
              </button>
            </div>
          </div>
        </div>
      )}

      {expenseReceiptPreview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Receipt preview"
          onClick={() => setExpenseReceiptPreview(null)}
          onWheel={preventModalBackdropWheel}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            overscrollBehavior: "contain",
            touchAction: "none"
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              padding: 10,
              borderRadius: 10,
              width: "min(92vw, 980px)",
              height: "min(88vh, 780px)",
              touchAction: "auto",
              overscrollBehavior: "contain"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <strong>{expenseReceiptPreview.name}</strong>
              <button type="button" onClick={() => setExpenseReceiptPreview(null)}>
                Close
              </button>
            </div>
            {expenseReceiptPreview.isPdf ? (
              <iframe title="Receipt PDF" src={expenseReceiptPreview.href} style={{ width: "100%", height: "calc(100% - 38px)", border: "1px solid #ddd" }} />
            ) : (
              <div style={{ width: "100%", height: "calc(100% - 38px)", overflow: "auto", display: "grid", placeItems: "center", border: "1px solid #ddd" }}>
                <img src={expenseReceiptPreview.href} alt="Receipt full preview" style={{ maxWidth: "100%", maxHeight: "100%" }} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
