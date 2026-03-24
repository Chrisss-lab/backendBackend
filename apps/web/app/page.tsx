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

/** Stop page scroll when the wheel happens on the dimmed backdrop (not on modal content). */
function preventModalBackdropWheel(e: WheelEvent<HTMLDivElement>) {
  if (e.target === e.currentTarget) e.preventDefault();
}

function normalizeRecipeRatioPercent(raw: unknown): number {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return 0;
    const hasPercentSign = s.includes("%");
    const numeric = Number(s.replace(/%/g, "").trim());
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    if (hasPercentSign) return numeric;
    return numeric < 0.01 ? numeric * 100 : numeric;
  }
  const n = Number(raw || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 0.01 ? n * 100 : n;
}

function formatRecipeRatioForInput(raw: unknown): string {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n) < 1e-12) return "0";
  return n.toFixed(6).replace(/\.?0+$/, "");
}

function parseRecipeRatioInput(raw: unknown): number {
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  const n = Number(s.replace(/%/g, "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : 0;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const tabs = [
  "Dashboard",
  "Customers",
  "Ingredients",
  "Recipes",
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
const paymentMethodOptions = ["Credit Card", "Zelle", "Cash", "Venmo"] as const;

async function apiGet<T>(path: string): Promise<T> {
  try {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (error: any) {
    if (error?.message?.toLowerCase().includes("failed to fetch")) {
      throw new Error(
        "Cannot reach your local backend (localhost:4000). This app is local-only; start/restart Backend Start.bat and try again."
      );
    }
    throw error;
  }
}

async function apiGetWithQuery<T>(path: string, query: Record<string, string | undefined>): Promise<T> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => {
    if (v && v.trim() !== "") params.set(k, v);
  });
  const q = params.toString();
  return apiGet<T>(q ? `${path}?${q}` : path);
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (error: any) {
    if (error?.message?.toLowerCase().includes("failed to fetch")) {
      throw new Error(
        "Save failed because local backend is offline (localhost:4000). Data stays local; restart Backend Start.bat."
      );
    }
    throw error;
  }
}

async function apiPostForm<T>(path: string, body: FormData): Promise<T> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      body
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (error: any) {
    if (error?.message?.toLowerCase().includes("failed to fetch")) {
      throw new Error(
        "Upload failed because local backend is offline (localhost:4000). Data is local-only; restart Backend Start.bat."
      );
    }
    throw error;
  }
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (error: any) {
    if (error?.message?.toLowerCase().includes("failed to fetch")) {
      throw new Error(
        "Update failed because local backend is offline (localhost:4000). Data is local-only; restart Backend Start.bat."
      );
    }
    throw error;
  }
}

async function apiDelete(path: string): Promise<void> {
  try {
    const res = await fetch(`${API}${path}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
  } catch (error: any) {
    if (error?.message?.toLowerCase().includes("failed to fetch")) {
      throw new Error(
        "Delete failed because local backend is offline (localhost:4000). Data is local-only; restart Backend Start.bat."
      );
    }
    throw error;
  }
}

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

function workersCalendarAppsScriptRange(ym: string, weekYmd: string): { startISO: string; endISO: string } {
  const parts = ym.split("-").map(Number);
  const y = parts[0] ?? new Date().getFullYear();
  const m = parts[1] ?? 1;
  const monthStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
  const ws = calendarStartOfWeekSunday(weekYmd);
  const we = calendarEndOfWeekSaturday(weekYmd);
  const rs = new Date(Math.min(monthStart.getTime(), ws.getTime()));
  rs.setDate(rs.getDate() - 14);
  rs.setHours(0, 0, 0, 0);
  const re = new Date(Math.max(monthEnd.getTime(), we.getTime()));
  re.setDate(re.getDate() + 14);
  re.setHours(23, 59, 59, 999);
  return { startISO: rs.toISOString(), endISO: re.toISOString() };
}

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

function calendarStartOfWeekSunday(ymd: string): Date {
  const d = new Date(ymd + "T12:00:00");
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function calendarEndOfWeekSaturday(ymd: string): Date {
  const s = calendarStartOfWeekSunday(ymd);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  e.setHours(23, 59, 59, 999);
  return e;
}

function calendarDateInWeek(eventYmd: string, weekAnyDayYmd: string): boolean {
  const d = new Date(eventYmd + "T12:00:00").getTime();
  const ws = calendarStartOfWeekSunday(weekAnyDayYmd).getTime();
  const we = calendarEndOfWeekSaturday(weekAnyDayYmd).getTime();
  return d >= ws && d <= we;
}

function calendarAddDaysYmd(ymd: string, delta: number): string {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function calendarMonthGridCells(year: number, monthIndex0: number): { day: number | null; ymd: string | null }[] {
  const first = new Date(year, monthIndex0, 1);
  const last = new Date(year, monthIndex0 + 1, 0);
  const startPad = first.getDay();
  const daysInMonth = last.getDate();
  const cells: { day: number | null; ymd: string | null }[] = [];
  for (let i = 0; i < startPad; i++) cells.push({ day: null, ymd: null });
  const ym = `${year}-${String(monthIndex0 + 1).padStart(2, "0")}`;
  for (let day = 1; day <= daysInMonth; day++) {
    const ymd = `${ym}-${String(day).padStart(2, "0")}`;
    cells.push({ day, ymd });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, ymd: null });
  return cells;
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
};
const fmtMoney = (value: unknown) =>
  Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    recoveryYears: 7
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
    recoveryYears: 7
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
    recoveryYears: 7
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
    recoveryYears: 7
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
    recoveryYears: 7
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
  const categoryOrder = ["Meats", "Organs", "Dairy", "Fruits/Veggies", "Fats", "Supplements", "Packaging", "Uncategorized"];
  const blankRecipeLines = [{ ingredientId: "", quantity: "" }];
  const blankBundleLines = [{ ingredientId: "", quantity: "" }];
  const [activeTab, setActiveTab] = useState<Tab>("Dashboard");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState<Record<string, number>>({});
  const [pnl, setPnl] = useState<Record<string, number>>({});
  const [customers, setCustomers] = useState<any[]>([]);
  const [ingredients, setIngredients] = useState<any[]>([]);
  const [recipes, setRecipes] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [promoCodes, setPromoCodes] = useState<any[]>([]);
  const [coopSummary, setCoopSummary] = useState<
    { promoCodeId: string; code: string; label: string; payeeNotes: string | null; orderCount: number; kickbackOwed: number; revenueTaxIncl: number }[]
  >([]);
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
  const [pendingPaymentMethodByOrder, setPendingPaymentMethodByOrder] = useState<Record<string, string>>({});
  const [partialAmountByOrder, setPartialAmountByOrder] = useState<Record<string, string>>({});
  const [editingOrderId, setEditingOrderId] = useState("");
  const [orderEditForm, setOrderEditForm] = useState({
    customerName: "",
    customerEmail: "",
    customerPhone: ""
  });
  const [orderEditItems, setOrderEditItems] = useState<Array<{ recipeId: string; quantityLbs: string }>>([{ recipeId: "", quantityLbs: "" }]);
  const [expenseForm, setExpenseForm] = useState({
    vendor: "",
    description: "",
    category: "",
    amount: "",
    payment: "",
    receiptPath: "",
    expenseDate: localDateTimeInputValue()
  });
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
  const [archiveOrderSearch, setArchiveOrderSearch] = useState("");
  const [archiveInvoiceBackfillMsg, setArchiveInvoiceBackfillMsg] = useState<string | null>(null);
  const [invoiceRegenerateMsg, setInvoiceRegenerateMsg] = useState<string | null>(null);
  const [customerLookupQuery, setCustomerLookupQuery] = useState("");
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
    if (typeof window === "undefined") return "both";
    try {
      const raw = window.localStorage.getItem("jr-calendar-source-mode");
      if (raw === "local" || raw === "workers" || raw === "both") return raw;
    } catch {
      /* ignore */
    }
    return "both";
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
    (o: any): Array<{ recipeName: string; quantityLbs: number }> => {
      try {
        const parsed = JSON.parse(String(o?.orderItemsJson || "[]"));
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed
            .map((x: any) => ({
              recipeName: String(x?.recipeName || "").trim(),
              quantityLbs: Number(x?.quantityLbs || 0)
            }))
            .filter((x: any) => x.recipeName && x.quantityLbs > 0);
        }
      } catch {
        // fallback below
      }
      const fallback = String(o?.recipe?.name || recipes.find((r: any) => r.id === o?.recipeId)?.name || "").trim();
      const lbs = Number(o?.quantityLbs || 0);
      if (fallback && lbs > 0) return [{ recipeName: fallback, quantityLbs: lbs }];
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
      .sort((a, b) => b.buyLbs - a.buyLbs || b.needLbs - a.needLbs);
    return rows;
  }, [makingRecipeBookDemandByRecipeId, recipes]);

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
    const lbs = Number(o?.quantityLbs || 0);
    const subtotal = Number(o?.subtotal || 0); // tax-included total
    const salesTax = subtotal * (0.06625 / 1.06625);
    const netRevenue = subtotal - salesTax;
    const cogs = Number(o?.cogs || 0);
    const profitTotal = Number(o?.margin || 0) || (cogs > 0 ? netRevenue - cogs : 0);
    const pricePerLb = lbs > 0 ? netRevenue / lbs : 0;
    const profitPerLb = lbs > 0 ? profitTotal / lbs : 0;
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

  const reportSummary = useMemo(() => {
    const fromDate = reportRange.from ? startOfDay(new Date(reportRange.from)) : null;
    const toDate = reportRange.to ? endOfDay(new Date(reportRange.to)) : null;
    const inRange = (value: unknown) => {
      const d = new Date(String(value || ""));
      if (Number.isNaN(d.getTime())) return false;
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    };
    const ordersInRange = orders.filter((o: any) => inRange(o.createdAt));
    const activeOrders = ordersInRange.filter((o: any) => o.status !== "CANCELLED");
    const cancelledOrders = ordersInRange.filter((o: any) => o.status === "CANCELLED");
    const expensesInRange = expenses.filter((e: any) => inRange(e.expenseDate || e.createdAt));

    const orderTotals = activeOrders.reduce(
      (acc: any, o: any) => {
        const m = orderMetrics(o);
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
    const expenseByCategoryMap = new Map<string, number>();
    for (const e of expensesInRange) {
      const key = String(e.category || "Other");
      expenseByCategoryMap.set(key, (expenseByCategoryMap.get(key) || 0) + Number(e.amount || 0));
    }
    const expenseByCategory = [...expenseByCategoryMap.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);

    const itemMap = new Map<string, { item: string; orders: number; lbs: number; salesTaxIncl: number; netSales: number; profit: number }>();
    for (const o of activeOrders) {
      const itemName = String(o.recipe?.name || recipes.find((r: any) => r.id === o.recipeId)?.name || "Unknown item");
      const m = orderMetrics(o);
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
    for (const o of activeOrders) {
      const name = String(o.customer?.name || "Unknown customer");
      const m = orderMetrics(o);
      customerMap.set(name, (customerMap.get(name) || 0) + m.subtotal);
    }
    const topCustomer = [...customerMap.entries()].sort((a, b) => b[1] - a[1])[0] || null;

    const avgOrderValue = orderTotals.orders > 0 ? orderTotals.salesTaxIncl / orderTotals.orders : 0;
    const profitPerLb = orderTotals.lbs > 0 ? orderTotals.profit / orderTotals.lbs : 0;
    const netAfterExpenses = orderTotals.salesTaxIncl - expenseTotal;
    const marginPct = orderTotals.netSales > 0 ? (orderTotals.profit / orderTotals.netSales) * 100 : 0;
    const expenseRatioPct = orderTotals.netSales > 0 ? (expenseTotal / orderTotals.netSales) * 100 : 0;

    return {
      fromDate,
      toDate,
      ordersInRangeCount: ordersInRange.length,
      cancelledOrderCount: cancelledOrders.length,
      expenseCount: expensesInRange.length,
      orderTotals,
      expenseTotal,
      expenseByCategory,
      items,
      avgOrderValue,
      profitPerLb,
      netAfterExpenses,
      marginPct,
      expenseRatioPct,
      topCustomer
    };
  }, [reportRange.from, reportRange.to, orders, expenses, recipes]);
  const dashboardWeekly = useMemo(() => {
    const weeksBack = dashboardWeeksBack;
    const now = new Date();
    const thisWeekStart = startOfDay(new Date(now));
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    const weekStarts = Array.from({ length: weeksBack }, (_, idx) => {
      const d = new Date(thisWeekStart);
      d.setDate(d.getDate() - (weeksBack - 1 - idx) * 7);
      return d;
    });
    const buckets = weekStarts.map((start) => {
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
    const getWeekIndex = (d: Date) => buckets.findIndex((b) => d >= b.start && d <= b.end);

    for (const o of orders) {
      const d = new Date(String(o.createdAt || ""));
      if (Number.isNaN(d.getTime())) continue;
      const idx = getWeekIndex(d);
      if (idx < 0) continue;
      if (String(o.status || "").toUpperCase() === "CANCELLED") {
        buckets[idx].cancelled += 1;
        continue;
      }
      const m = orderMetrics(o);
      buckets[idx].orders += 1;
      buckets[idx].lbs += m.lbs;
      buckets[idx].salesTaxIncl += m.subtotal;
      buckets[idx].netSales += m.netRevenue;
      buckets[idx].taxCollected += m.salesTax;
      buckets[idx].cogs += m.cogs;
    }
    for (const e of expenses) {
      const d = new Date(String(e.expenseDate || e.createdAt || ""));
      if (Number.isNaN(d.getTime())) continue;
      const idx = getWeekIndex(d);
      if (idx < 0) continue;
      buckets[idx].expenses += Number(e.amount || 0);
    }
    for (const w of buckets) {
      // Profit follows the business rule: revenue - expenses.
      w.profit = w.salesTaxIncl - w.expenses;
    }

    const totals = buckets.reduce(
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
    const maxSales = Math.max(1, ...buckets.map((w) => w.salesTaxIncl));
    const maxProfit = Math.max(1, ...buckets.map((w) => w.profit));
    const maxExpenses = Math.max(1, ...buckets.map((w) => w.expenses));
    const allMoney = buckets.flatMap((w) => [w.salesTaxIncl, w.profit, w.expenses]);
    const lineScaleMax = Math.max(1, ...allMoney.map((v) => Math.abs(v)));
    return { buckets, totals, maxSales, maxProfit, maxExpenses, weeksBack, lineScaleMax };
  }, [orders, expenses, dashboardWeeksBack]);
  const dashboardPeriodBounds = useMemo(() => {
    const weeksBack = dashboardWeeksBack;
    const now = new Date();
    const thisWeekStart = startOfDay(new Date(now));
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
    const rangeStart = startOfDay(new Date(thisWeekStart));
    rangeStart.setDate(rangeStart.getDate() - (weeksBack - 1) * 7);
    const rangeEnd = endOfDay(new Date(thisWeekStart));
    rangeEnd.setDate(rangeEnd.getDate() + 6);
    return { rangeStart, rangeEnd };
  }, [dashboardWeeksBack]);
  const dashboardLeaderboards = useMemo(() => {
    const best = <T,>(rows: T[], score: (row: T) => number) =>
      [...rows].sort((a, b) => score(b) - score(a))[0] ?? null;

    const weekly = dashboardWeekly.buckets.map((w) => ({
      label: w.label,
      start: w.start,
      end: w.end,
      grossProfit: w.profit,
      netAfterExpenses: w.salesTaxIncl - w.expenses,
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
          lbs: 0,
          orders: 0
        } as const);
      const m = orderMetrics(o);
      monthMap.set(key, {
        ...cur,
        grossProfit: cur.grossProfit + m.profitTotal,
        sales: cur.sales + m.subtotal,
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
          lbs: 0,
          orders: 0
        } as const);
      monthMap.set(key, {
        ...cur,
        expenses: cur.expenses + Number(e.amount || 0)
      });
    }
    const monthly = [...monthMap.values()]
      .map((m) => ({ ...m, netAfterExpenses: m.sales - m.expenses }))
      .sort((a, b) => a.key.localeCompare(b.key));

    return {
      bestWeekNet: best(weekly, (x) => x.netAfterExpenses),
      bestWeekGross: best(weekly, (x) => x.grossProfit),
      bestWeekLbs: best(weekly, (x) => x.lbs),
      bestWeekSales: best(weekly, (x) => x.sales),
      bestMonthNet: best(monthly, (x) => x.netAfterExpenses),
      bestMonthGross: best(monthly, (x) => x.grossProfit),
      bestMonthLbs: best(monthly, (x) => x.lbs),
      bestMonthSales: best(monthly, (x) => x.sales)
    };
  }, [dashboardWeekly.buckets, orders, expenses]);
  /** Non-cancelled lbs by recipe name for the same window as the dashboard weekly chart (for KPI card + drill consistency). */
  const dashboardPeriodLbsByRecipe = useMemo(() => {
    const p0 = dashboardPeriodBounds.rangeStart;
    const p1 = dashboardPeriodBounds.rangeEnd;
    const ordersInPeriod = orders.filter((o: any) => {
      const d = new Date(o.createdAt);
      return d >= p0 && d <= p1;
    });
    const m = new Map<string, number>();
    for (const o of ordersInPeriod) {
      if (String(o.status || "").toUpperCase() === "CANCELLED") continue;
      const om = orderMetrics(o);
      const name = String(o.recipe?.name || recipes.find((r: any) => r.id === o.recipeId)?.name || "—");
      m.set(name, (m.get(name) || 0) + om.lbs);
    }
    return [...m.entries()]
      .map(([recipe, lbs]) => ({ recipe, lbs }))
      .sort((a, b) => b.lbs - a.lbs);
  }, [orders, recipes, dashboardPeriodBounds]);
  const openDashboardWeekDrill = useCallback((w: { start: Date; end: Date; label: string }) => {
    setDashboardDrill({
      type: "week",
      label: w.label,
      startIso: w.start.toISOString(),
      endIso: w.end.toISOString()
    });
  }, []);
  const dashboardLifetimeStats = useMemo(() => {
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
    const expenseByCategoryMap = new Map<string, number>();
    const itemMap = new Map<string, { item: string; orders: number; lbs: number; salesTaxIncl: number; netSales: number; profit: number }>();

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
      const m = orderMetrics(o);
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
      const curr = itemMap.get(itemName) || { item: itemName, orders: 0, lbs: 0, salesTaxIncl: 0, netSales: 0, profit: 0 };
      curr.orders += 1;
      curr.lbs += m.lbs;
      curr.salesTaxIncl += m.subtotal;
      curr.netSales += m.netRevenue;
      curr.profit += m.profitTotal;
      itemMap.set(itemName, curr);
    }

    for (const e of expenses) {
      const key = String(e.category || "Other");
      expenseByCategoryMap.set(key, (expenseByCategoryMap.get(key) || 0) + Number(e.amount || 0));
    }
    const expenseTotal = [...expenseByCategoryMap.values()].reduce((a, b) => a + b, 0);
    const expenseByCategory = [...expenseByCategoryMap.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);
    const topItems = [...itemMap.values()].sort((a, b) => b.salesTaxIncl - a.salesTaxIncl).slice(0, 12);

    const avgOrderTaxIncl = activeOrders > 0 ? salesTaxIncl / activeOrders : 0;
    const profitPerLb = totalLbs > 0 ? totalProfit / totalLbs : 0;
    const netPerLb = totalLbs > 0 ? netSales / totalLbs : 0;
    const marginPct = netSales > 0 ? (totalProfit / netSales) * 100 : 0;
    const netAfterExpenses = salesTaxIncl - expenseTotal;
    const expenseRatioPct = netSales > 0 ? (expenseTotal / netSales) * 100 : 0;

    let invoiceRecordsPaid = 0;
    for (const inv of invoices) {
      const st = String(inv?.payment?.status || "").toUpperCase();
      if (st === "PAID") invoiceRecordsPaid += 1;
    }

    return {
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
      expenseTotal,
      expenseEntryCount: expenses.length,
      expenseByCategory,
      topItems,
      avgOrderTaxIncl,
      profitPerLb,
      netPerLb,
      marginPct,
      netAfterExpenses,
      expenseRatioPct,
      invoicesOnOrders,
      invoicedAmount,
      invoiceRecordsCount: invoices.length,
      invoiceRecordsPaid,
      inventoryLotCount: inventory.length,
      recipeCount: recipes.length,
      ingredientCount: ingredients.length,
      customerRecordsCount: customers.length
    };
  }, [orders, expenses, recipes, invoices, inventory, customers, ingredients]);
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
      const accumulated = Math.min(asset.depreciableBasis, monthlyDepreciation * monthsElapsed);
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

  /** Matches server: COUPON lowers customer total; COOP keeps full price and accrues kickback (shown for your reference). */
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
    let discountPreTax = 0;
    let coopKickback = 0;
    if (promo.kind === "COUPON") {
      const pct = Number(promo.discountPercent || 0);
      const fix = Number(promo.discountFixed || 0);
      if (pct > 0) discountPreTax += (baseNet * pct) / 100;
      if (fix > 0) discountPreTax += fix;
      discountPreTax = Math.min(baseNet, Math.max(0, discountPreTax));
    } else if (promo.kind === "COOP") {
      const kp = Number(promo.kickbackPercent || 0);
      const kf = Number(promo.kickbackFixed || 0);
      coopKickback = Math.max(0, (baseNet * kp) / 100 + kf);
    }
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
  /** Customers who appear on at least one Pending (NEW/CONFIRMED) or Archive (FULFILLED/CANCELLED) order — no manual directory. */
  const customerIdsFromOrders = useMemo(() => {
    const ids = new Set<string>();
    for (const o of orders) {
      const s = String(o.status || "");
      if (s === "NEW" || s === "CONFIRMED" || s === "FULFILLED" || s === "CANCELLED") {
        if (o.customerId) ids.add(o.customerId);
      }
    }
    return ids;
  }, [orders]);
  const customerLookupRows = useMemo(() => {
    const raw = customerLookupQuery;
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }
    const qLower = trimmed.toLowerCase();
    const qDigits = phoneDigitsOnly(trimmed);
    const matches = customers.filter(
      (c: any) => customerIdsFromOrders.has(c.id) && customerMatchesLookupQuery(c, raw)
    );
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
  }, [customerLookupQuery, customers, orders, customerIdsFromOrders]);

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
    const filtered = ingredients.filter((item: any) =>
      item.name.toLowerCase().includes(ingredientSearch.toLowerCase().trim())
    );
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

  const recipeCalculator = useMemo(() => {
    const parsed = recipeLines
      .filter((line) => line.ingredientId && parseRecipeRatioInput(line.quantity) > 0)
      .map((line) => {
        const raw = parseRecipeRatioInput(line.quantity);
        const pct = raw;
        return { ingredientId: line.ingredientId, percent: Number.isFinite(pct) ? pct : 0 };
      })
      .filter((x) => x.percent > 0);

    const totalPercent = parsed.reduce((sum, x) => sum + x.percent, 0);
    const weightedCost = parsed.reduce((sum, x) => {
      const ing = ingredientById[x.ingredientId];
      return sum + (x.percent / 100) * Number(ing?.pricePerLb ?? 0);
    }, 0);
    const weightedCharge = parsed.reduce((sum, x) => {
      const ing = ingredientById[x.ingredientId];
      return sum + (x.percent / 100) * Number(ing?.chargePerPound ?? 0);
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
  }, [recipeLines, ingredientById, bundleLines, recipeById]);
  const recipePercentDeltaTo100 = useMemo(() => Number((100 - recipeCalculator.totalPercent).toFixed(2)), [recipeCalculator.totalPercent]);
  const filteredRecipes = useMemo(() => {
    const q = recipeSearch.trim().toLowerCase();
    const baseSearched = !q
      ? rows.recipes
      : rows.recipes.filter((r: any) => {
          const recipeName = String(r.name ?? "").toLowerCase();
          const mixText = (r.ingredients || [])
            .map((ri: any) => `${ri.ingredient?.name ?? ""} ${Number(ri.quantity).toFixed(2)}%`)
            .join(" ")
            .toLowerCase();
          return recipeName.includes(q) || mixText.includes(q);
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
    const [description = "", payment = ""] = rawNotes.split(" | ").map((part) => part.trim());
    return {
      description,
      payment,
      receipt: String(row?.receiptPath || "")
    };
  };

  const buildExpenseNotes = (description: string, payment: string) =>
    [String(description || "").trim(), String(payment || "").trim()].filter(Boolean).join(" | ");
  const resolveReceiptHref = (value: string) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const urlMatch = raw.match(/https?:\/\/\S+/i);
    const extracted = (urlMatch?.[0] || raw).trim();
    if (/^https?:\/\//i.test(extracted)) return extracted;
    if (extracted.startsWith("/uploads/")) return `${API}${extracted}`;
    if (extracted.startsWith("uploads/")) return `${API}/${extracted}`;
    return "";
  };
  const resolveInvoiceHref = (value: string) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith("/")) return `${API}${raw}`;
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

  const filteredRecipeLinesByRatio = (lines: Array<{ ingredientId: string; quantity: string }>) => {
    return [...lines].sort((a, b) => Number(b.quantity || 0) - Number(a.quantity || 0));
  };

  const filteredRecipesCountText = filteredRecipes.length === 1 ? "1 recipe" : `${filteredRecipes.length} recipes`;

  const ___ = filteredRecipeLinesByRatio;

  const recipeRows = filteredRecipes;

  const sortRecipeLinesForSave = (lines: Array<{ ingredientId: string; quantity: string }>) => ___(lines);

  const getSortedRecipeIngredients = (r: any) => filteredRecipeIngredientsByRatio(r);

  const getSortedLinesForEdit = (lines: Array<{ ingredientId: string; quantity: string }>) => ___(lines);

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

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      try {
        await apiPost("/operations/invoices/sync-pending", {});
      } catch {
        // Best-effort: orders still load; Pending/Archive tabs also run sync when opened.
      }
      const [
        overviewData,
        pnlData,
        customersData,
        ingredientsData,
        recipesData,
        inventoryData,
        ordersData,
        expensesData,
        invoicesData,
        promoCodesData
      ] = await Promise.all([
        apiGet<Record<string, number>>("/operations/overview"),
        apiGet<Record<string, number>>("/reports/pnl"),
        apiGet<any[]>("/operations/customers"),
        apiGet<any[]>("/operations/ingredients"),
        apiGet<any[]>("/operations/recipes"),
        apiGet<any[]>("/operations/inventory"),
        apiGet<any[]>("/operations/orders"),
        apiGet<any[]>("/operations/expenses"),
        apiGet<any[]>("/operations/invoices"),
        apiGet<any[]>("/operations/promo-codes")
      ]);
      setOverview(overviewData);
      setPnl(pnlData);
      setCustomers(customersData);
      setIngredients(ingredientsData);
      setRecipes(recipesData);
      setInventory(inventoryData);
      setOrders(ordersData);
      setExpenses(expensesData);
      setInvoices(invoicesData);
      setPromoCodes(promoCodesData);
      await loadFinanceData();
    } catch (e: any) {
      setError(e.message || "Failed to load data.");
    } finally {
      setLoading(false);
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

  useEffect(() => {
    void loadAll();
  }, []);

  /** Whenever you open Pending Orders, backfill missing invoices/PDFs and refresh list (no button required). */
  useEffect(() => {
    if (activeTab !== "Pending Orders") return;
    let cancelled = false;
    void (async () => {
      try {
        await apiPost("/operations/invoices/sync-pending", {});
      } catch {
        // Non-fatal — list still loads from last fetch.
      }
      if (cancelled) return;
      try {
        const [ordersData, invoicesData] = await Promise.all([
          apiGet<any[]>("/operations/orders"),
          apiGet<any[]>("/operations/invoices")
        ]);
        if (cancelled) return;
        setOrders(ordersData);
        setInvoices(invoicesData);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  /** Archive tab: backfill missing invoices/PDFs for archived orders (same idea as Pending). */
  useEffect(() => {
    if (activeTab !== "Archive Orders") return;
    let cancelled = false;
    void (async () => {
      try {
        await apiPost("/operations/invoices/sync-archive", {});
      } catch {
        // Non-fatal
      }
      if (cancelled) return;
      try {
        const [ordersData, invoicesData] = await Promise.all([
          apiGet<any[]>("/operations/orders"),
          apiGet<any[]>("/operations/invoices")
        ]);
        if (cancelled) return;
        setOrders(ordersData);
        setInvoices(invoicesData);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "Coupons & Co-ops") return;
    let cancelled = false;
    void (async () => {
      try {
        const [pc, cs] = await Promise.all([
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
            }[]
          >("/operations/promo-codes/coop-summary")
        ]);
        if (cancelled) return;
        setPromoCodes(pc);
        setCoopSummary(cs);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

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

  function confirmValue(value: unknown) {
    if (value === undefined) return "(not set)";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

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
    confirmation?: false | { title: string; from?: unknown; to?: unknown }
  ) {
    setError("");
    const confirmDetails: { title: string; from?: unknown; to?: unknown } | null =
      confirmation === false
        ? null
        : confirmation === undefined
          ? { title: "Confirm change", from: "Current saved values", to: "Apply this update" }
          : confirmation;
    if (confirmDetails) {
      const ok = await requestConfirm(confirmDetails);
      if (!ok) return;
    }
    try {
      await handler();
      await loadAll();
    } catch (e: any) {
      setError(e.message || "Action failed.");
    }
  }

  async function runReadOnly(handler: () => Promise<unknown>) {
    setError("");
    try {
      await handler();
    } catch (e: any) {
      setError(e.message || "Action failed.");
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
        ingredientId: item.ingredientId,
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
    const phoneDigits = String(order.customer?.phone || "").replace(/\D/g, "") || "nophone";
    const defaultInvoiceNumber = order.invoice?.invoiceNumber || `${orderDate}-${phoneDigits}`;
    setInvoiceBuilder((prev) => ({
      ...prev,
      orderId,
      invoiceNumber: prev.invoiceNumber || defaultInvoiceNumber,
      billToName: order.customer?.name || "",
      billToEmail: order.customer?.email || "",
      billToPhone: order.customer?.phone || ""
    }));
    setInvoiceLines([{ description: `Order for ${order.customer?.name || "customer"}`, quantity: "1", unitPrice: Number(order.subtotal || 0).toFixed(2) }]);
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

  const orderRecipeLabel = (o: any) => String(o.productSummary || o.recipe?.name || recipes.find((r: any) => r.id === o.recipeId)?.name || "—");

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

    const tblLbsRecipe = (rows: { recipe: string; orderCount: number; lbs: number; net: number; profit: number; salesIncl: number }[]) => (
      <div style={{ overflowX: "auto", maxHeight: "min(50vh, 480px)", overflowY: "auto" }}>
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
        body = tblLbsRecipe(aggLbs(ordersInPeriod));
        break;
      case "lbs-recipe-lifetime":
        title = "Lbs / product mix — lifetime";
        body = tblLbsRecipe(aggLbs(orders));
        break;
      case "net-after-period": {
        title = `Net after expenses — ${periodStr}`;
        const ps = profitSum(ordersInPeriod);
        const es = expSum(expensesInPeriod);
        subtitle = `Gross profit (non-cancelled in range) ${fmtMoney(ps)} − expenses in range ${fmtMoney(es)} = ${fmtMoney(ps - es)}`;
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
        title = "Net after expenses — lifetime";
        const ps = profitSum(orders);
        const es = expSum(expenses);
        subtitle = `Gross profit (non-cancelled) ${fmtMoney(ps)} − all expenses ${fmtMoney(es)} = ${fmtMoney(ps - es)}`;
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
        subtitle = "Values from /reports/pnl — use for accountant-facing totals.";
        body = (
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              Revenue: <SignedMoney value={pnl.revenue} />
            </li>
            <li>
              Expenses: <SignedMoney value={pnl.expenses} />
            </li>
            <li>
              Profit (Revenue - Expenses): <SignedMoney value={pnl.netProfit} />
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
            {tblLbsRecipe(aggLbs(wOrders))}
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
          API:{" "}
          <code style={{ background: "#bbf7d0", color: "#14532d", border: "1px solid #4ade80", padding: "2px 8px", borderRadius: 6 }}>{API}</code>
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
        <button onClick={() => void loadAll()} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
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
                    { label: "COGS", drill: { type: "orders-money-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.totalCogs} /> },
                    { label: "Gross profit", drill: { type: "orders-money-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.totalProfit} /> },
                    { label: "Expenses (all)", drill: { type: "expenses-all" as const }, node: <SignedMoney value={dashboardLifetimeStats.expenseTotal} /> },
                    { label: "Net after expenses", drill: { type: "net-after-lifetime" as const }, node: <SignedMoney value={dashboardLifetimeStats.netAfterExpenses} /> },
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
                    { label: "Expense ratio %", drill: { type: "net-after-lifetime" as const }, node: <PctColored value={-dashboardLifetimeStats.expenseRatioPct} /> },
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
                  <p style={{ margin: "0 0 8px", fontSize: 11, color: "#14532d" }}>Click this card for lbs sold by recipe</p>
                  {dashboardLifetimeStats.topItems.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13 }}>No non-cancelled orders yet.</p>
                  ) : (
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6, textAlign: "left" }}>Item</th>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6 }}>Orders</th>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6 }}>Lbs</th>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6 }}>Sales (incl.)</th>
                          <th style={{ border: "1px solid #e5e7eb", padding: 6 }}>Profit</th>
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
              <p style={{ marginTop: 0, fontSize: 12, color: "#64748b" }}>Click any line for the full P&amp;L popup.</p>
              <ul style={{ margin: 0, fontSize: 14, lineHeight: 1.8, paddingLeft: 0, listStyle: "none" }}>
                <li>
                  <button type="button" onClick={() => setDashboardDrill({ type: "pnl-books" })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}>
                    Revenue: <SignedMoney value={pnl.revenue} />
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => setDashboardDrill({ type: "pnl-books" })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}>
                    Expenses: <SignedMoney value={pnl.expenses} />
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => setDashboardDrill({ type: "pnl-books" })} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}>
                    Profit (Revenue - Expenses): <SignedMoney value={pnl.netProfit} />
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
                { label: `${dashboardWeeksBack}w Expenses`, drill: { type: "expenses-period" as const }, node: <SignedMoney value={dashboardWeekly.totals.expenses} /> },
                {
                  label: `${dashboardWeeksBack}w Profit (Revenue - Expenses)`,
                  drill: { type: "net-after-period" as const },
                  node: <SignedMoney value={dashboardWeekly.totals.salesTaxIncl - dashboardWeekly.totals.expenses} />,
                  desc: "Sum of weekly revenue (tax included) minus weekly expenses in the selected range."
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
                  desc: "Profit (Revenue - Expenses) divided by lbs sold in the selected week range."
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
            <p style={{ marginTop: 0, fontSize: 13, color: "#466251" }}>Blue = Revenue (tax incl.), Green = Profit (Revenue - Expenses), Red = Expenses</p>
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
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Expenses</th>
                  <th style={{ border: "1px solid #cfd8d1", padding: 6 }}>Profit (Revenue - Expenses)</th>
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
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "right" }}><SignedMoney value={w.expenses} /></td>
                    <td style={{ border: "1px solid #cfd8d1", padding: 6, textAlign: "right" }}><SignedMoney value={w.salesTaxIncl - w.expenses} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Profit and Loss (All Time)</h3>
          <p style={{ marginTop: 0, fontSize: 12, color: "#64748b" }}>Click any line for the books P&amp;L popup (same as the lifetime panel).</p>
          <ul style={{ margin: 0, fontSize: 14, lineHeight: 1.8, paddingLeft: 0, listStyle: "none" }}>
            <li>
              <button
                type="button"
                onClick={() => setDashboardDrill({ type: "pnl-books" })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}
              >
                Revenue: <SignedMoney value={pnl.revenue} />
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setDashboardDrill({ type: "pnl-books" })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}
              >
                Expenses: <SignedMoney value={pnl.expenses} />
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => setDashboardDrill({ type: "pnl-books" })}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#1f4d37", font: "inherit", textDecoration: "underline" }}
              >
                Profit (Revenue - Expenses): <SignedMoney value={pnl.netProfit} />
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
            <input
              placeholder="Type name, email, or phone — list narrows as you type"
              value={customerLookupQuery}
              onChange={(e) => setCustomerLookupQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              style={{ minWidth: 360 }}
            />
            <p style={{ marginTop: 6, marginBottom: 0, fontSize: 13, color: "#3d5c45" }}>
              Matches if <strong>any</strong> field contains what you type (name, email, or phone). Digits-only phone search ignores spaces, dashes, and parentheses. In order history, <span style={{ background: "#fff6cc", padding: "0 6px", borderRadius: 4 }}>yellow</span> = pending (not complete). Click a customer for lifetime totals.
            </p>
          </div>
          {!customerLookupQuery.trim() ? (
            <p style={{ color: "#5a6b5f" }}>Start typing to search — results update on every keystroke.</p>
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

      {activeTab === "Ingredients" && (
        <section>
          <h2>Ingredients (Organized + Easy Updates)</h2>
          <p>Track quantity, cost, and price. Search ingredients quickly and update amount/cost/charge directly in each row.</p>
          <input
            placeholder="Search ingredients..."
            value={ingredientSearch}
            onChange={(e) => setIngredientSearch(e.target.value)}
            style={{ marginBottom: 10, minWidth: 280 }}
          />
          <h3>Purchase Update (when you buy more)</h3>
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
            <button type="submit">Apply Purchase</button>
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
                <strong>{selected.name}</strong> | Qty: {Number(selected.quantityOnHand || 0).toFixed(2)} -&gt; {nextQty.toFixed(2)} | Cost:{" "}
                <SignedMoney value={selected.totalCost} /> -&gt; <SignedMoney value={nextCost} />
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
              <button type="submit">Add</button>
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
                      <th style={{ border: "1px solid #ccc", padding: 6 }}>Inventory Left (lb)</th>
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

      {activeTab === "Recipes" && (
        <section>
          <h2>Recipes (Spreadsheet Style)</h2>
          <p>Set cost per lb, then choose charge per lb or per bag. Dog food can stay per lb; treats can be charged per bag with amount per unit.</p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              placeholder="Search recipes or ingredients..."
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
              <option value="name">Sort By: Recipe</option>
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
                .filter((line) => line.ingredientId && parseRecipeRatioInput(line.quantity) > 0)
                .map((line) => ({
                  ingredientId: line.ingredientId,
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
                      setRecipeSaveNotice(`Recipe updated: ${body.name}`);
                    } else {
                      const createdRecipe: any = await apiPost("/operations/recipes/full", body);
                      const freshRecipes = await apiGetRecipes();
                      const fresh = freshRecipes.find((r: any) => r.id === createdRecipe?.id);
                      if (fresh) loadRecipeForEdit(fresh);
                      setRecipeSaveNotice(`Recipe created: ${body.name}`);
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
                Editing recipe: <strong>{recipeForm.name || "(unnamed)"}</strong>
              </div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1.8fr 1fr 1fr 1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
              <input placeholder="Recipe name" value={recipeForm.name} onChange={(e) => setRecipeForm({ ...recipeForm, name: e.target.value })} required />
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
              Bundle recipe (contains other recipes like Dog Flight)
            </label>

            <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 8, marginBottom: 8 }}>
              <strong>Ingredients and Ratio (%)</strong>
              {recipeLines.map((line, idx) => (
                <div key={`line-${idx}`} style={{ display: "grid", gridTemplateColumns: "120px 2fr 1fr", gap: 8, marginTop: 6 }}>
                  <label>Ingredient {idx + 1}</label>
                  <select
                    value={line.ingredientId}
                    onChange={(e) => {
                      const next = [...recipeLines];
                      next[idx] = { ...next[idx], ingredientId: e.target.value };
                      setRecipeLines(next);
                    }}
                  >
                    <option value="">Select ingredient</option>
                    {ingredientsForSelect.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
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
                  onClick={() => setRecipeLines([...recipeLines, { ingredientId: "", quantity: "" }])}
                >
                  + Add Ingredient Line
                </button>
                <button
                  type="button"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    const fromIngredients = ingredientsForSelect
                      .filter((i: any) => Number(i.percentAdded || 0) > 0)
                      .map((i: any) => ({
                        ingredientId: i.id,
                        quantity: String(Number(i.percentAdded))
                      }));
                    setRecipeLines(fromIngredients.length ? fromIngredients : blankRecipeLines);
                  }}
                >
                  Load From Ingredient % Added
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
                <strong>Bundle Items (other recipes)</strong>
                {bundleLines.map((line, idx) => (
                  <div key={`bundle-${idx}`} style={{ display: "grid", gridTemplateColumns: "120px 2fr 1fr", gap: 8, marginTop: 6 }}>
                    <label>Recipe {idx + 1}</label>
                    <select
                      value={line.ingredientId}
                      onChange={(e) => {
                        const next = [...bundleLines];
                        next[idx] = { ...next[idx], ingredientId: e.target.value };
                        setBundleLines(next);
                      }}
                    >
                      <option value="">Select recipe</option>
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
                    + Add Bundle Recipe
                  </button>
                  {bundleLines.length > 1 && (
                    <button type="button" style={{ marginLeft: 8 }} onClick={() => setBundleLines(bundleLines.slice(0, -1))}>
                      - Remove Last Bundle Recipe
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
                {recipeSubmitting ? "Saving..." : editingRecipeId ? "Update Recipe" : "Add Recipe"}
              </button>
            </div>
          </form>

          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 980 }}>
              <thead>
                <tr>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Margin %</th>
                  <th style={{ border: "1px solid #ccc", padding: 6 }}>Recipe</th>
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
            Optional <strong>coupon / co-op code</strong>: coupons reduce the customer total; co-op codes keep full price and accrue a kickback you can track on <strong>Coupons & Co-ops</strong>.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
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
                    paymentMethod: submitOrderForm.paymentMethod.trim() || undefined,
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
              Payment method (optional — can set later on Pending Orders)
              <select
                value={submitOrderForm.paymentMethod}
                onChange={(e) => setSubmitOrderForm({ ...submitOrderForm, paymentMethod: e.target.value })}
              >
                <option value="">—</option>
                {paymentMethodOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
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
                  if (promo.kind === "COOP") {
                    setSubmitOrderPromoCheck({
                      kind: "ok",
                      text: `Co-op code ${promo.code} applied (${promo.label}). Kickback is tracked; customer pays full price.`
                    });
                    return;
                  }
                  setSubmitOrderPromoCheck({
                    kind: "ok",
                    text: `Coupon ${promo.code} applied (${promo.label}). Discount will be applied at submit.`
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
              {submitOrderPromoPreview.matched?.kind === "COUPON" && submitOrderPromoPreview.discountPreTax > 0 ? (
                <div style={{ fontSize: 13, color: "#166534", marginBottom: 6 }}>
                  Coupon <strong>{submitOrderPromoPreview.matched.code}</strong> — pre-tax discount{" "}
                  <SignedMoney value={submitOrderPromoPreview.discountPreTax} />
                </div>
              ) : null}
              {submitOrderPromoPreview.matched?.kind === "COOP" ? (
                <div style={{ fontSize: 13, color: "#1e40af", marginBottom: 6 }}>
                  Co-op <strong>{submitOrderPromoPreview.matched.code}</strong> — customer pays full price; est. kickback owed{" "}
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
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {pendingOrders.map((o: any) => (
                  <li key={o.id} style={{ marginBottom: 12, background: pendingOrderRowColor(o), border: "1px solid #cfe0d4", borderRadius: 12, padding: 14 }}>
                    {(() => {
                      const m = orderMetrics(o);
                      const recipe = orderRecipeLabel(o);
                      const name = String(o.customer?.name || "—");
                      const phone = String(o.customer?.phone || "").trim() || "—";
                      const email = String(o.customer?.email || "").trim();
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
                          let parsedItems: Array<{ recipeId: string; quantityLbs: string }> = [];
                          try {
                            const raw = JSON.parse(String(o.orderItemsJson || "[]"));
                            if (Array.isArray(raw)) {
                              parsedItems = raw
                                .map((x: any) => {
                                  const rid = recipes.find((r: any) => String(r.name || "") === String(x.recipeName || ""))?.id || "";
                                  return { recipeId: rid, quantityLbs: String(Number(x.quantityLbs || 0) || "") };
                                })
                                .filter((x) => x.recipeId && Number(x.quantityLbs || 0) > 0);
                            }
                          } catch {
                            // ignore and fallback
                          }
                          if (parsedItems.length === 0) {
                            parsedItems = [{ recipeId: String(o.recipeId || ""), quantityLbs: String(m.lbs || "") }].filter(
                              (x) => x.recipeId && Number(x.quantityLbs || 0) > 0
                            );
                          }
                          if (parsedItems.length === 0) parsedItems = [{ recipeId: "", quantityLbs: "" }];
                          setEditingOrderId(o.id);
                          setOrderEditForm({
                            customerName: String(o.customer?.name || ""),
                            customerEmail: String(o.customer?.email || ""),
                            customerPhone: String(o.customer?.phone || "")
                          });
                          setOrderEditItems(parsedItems);
                        }}
                      >
                        Edit Order
                      </button>
                      <select
                        value={pendingPaymentMethodByOrder[o.id] ?? o.paymentMethod ?? ""}
                        onChange={(e) => setPendingPaymentMethodByOrder((prev) => ({ ...prev, [o.id]: e.target.value }))}
                      >
                        <option value="">Payment method</option>
                        {paymentMethodOptions.map((pm) => (
                          <option key={pm} value={pm}>
                            {pm}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          void submit(async () => {
                            await apiPut(`/operations/orders/${o.id}/progress`, {
                              paid: true,
                              paymentMethod: pendingPaymentMethodByOrder[o.id] || o.paymentMethod || "Credit Card"
                            });
                          }, {
                            title: "Confirm paid status update",
                            from: { orderId: o.id, paid: Boolean(o.paidAt), paymentMethod: o.paymentMethod || "" },
                            to: { orderId: o.id, paid: true, paymentMethod: pendingPaymentMethodByOrder[o.id] || o.paymentMethod || "Credit Card" }
                          })
                        }
                      >
                        Mark Paid
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
                        onClick={() =>
                          void submit(async () => {
                            const amount = Number(partialAmountByOrder[o.id] || 0);
                            if (!(amount > 0)) throw new Error("Enter a partial payment amount greater than 0.");
                            const method = pendingPaymentMethodByOrder[o.id] || o.paymentMethod || "";
                            if (!method) throw new Error("Select a payment method before applying partial payment.");
                            await apiPut(`/operations/orders/${o.id}/partial-payment`, {
                              amount,
                              paymentMethod: method
                            });
                            setPartialAmountByOrder((prev) => ({ ...prev, [o.id]: "" }));
                          }, {
                            title: "Confirm partial payment",
                            from: { orderId: o.id, paymentStatus: o.paymentStatus || "UNPAID" },
                            to: {
                              orderId: o.id,
                              amount: Number(partialAmountByOrder[o.id] || 0),
                              paymentMethod: pendingPaymentMethodByOrder[o.id] || o.paymentMethod || ""
                            }
                          })
                        }
                      >
                        Apply Partial
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void submit(async () => {
                            await apiPut(`/operations/orders/${o.id}/progress`, { pickedUp: true });
                          }, {
                            title: "Confirm pickup update",
                            from: { orderId: o.id, pickedUp: Boolean(o.pickedUpAt) },
                            to: { orderId: o.id, pickedUp: true }
                          })
                        }
                      >
                        Picked Up
                      </button>
                      <span style={{ fontSize: 12 }}>
                        Paid at: {o.paidAt ? new Date(o.paidAt).toLocaleString() : "Not paid"} | Picked up at: {o.pickedUpAt ? new Date(o.pickedUpAt).toLocaleString() : "Not picked up"}
                      </span>
                      <span style={{ fontSize: 12 }}>
                        Paid amount: <SignedMoney value={Number(o.invoice?.payment?.amount || 0)} /> | Remaining:{" "}
                        <SignedMoney value={Math.max(0, Number(o.invoice?.amount || 0) - Number(o.invoice?.payment?.amount || 0))} /> | Status:{" "}
                        {String(o.paymentStatus || "UNPAID").toUpperCase()}
                      </span>
                    </div>
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <input
                        placeholder="Add note to this order"
                        value={orderNoteById[o.id] ?? o.notes ?? ""}
                        onChange={(e) => setOrderNoteById((prev) => ({ ...prev, [o.id]: e.target.value }))}
                        style={{ minWidth: 320 }}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          void submit(async () => {
                            await apiPut(`/operations/orders/${o.id}`, {
                              notes: String(orderNoteById[o.id] ?? o.notes ?? "").trim()
                            });
                          }, {
                            title: "Confirm order note update",
                            from: { orderId: o.id, note: o.notes || "" },
                            to: { orderId: o.id, note: String(orderNoteById[o.id] ?? o.notes ?? "").trim() }
                          })
                        }
                      >
                        Save Note
                      </button>
                    </div>
                    {o.notes ? <div style={{ marginTop: 4, fontSize: 12, color: "#1f4d37" }}>Note: {o.notes}</div> : null}
                    {o.promoCode || o.promoCodeEntered ? (
                      <div style={{ marginTop: 6, fontSize: 12, color: "#1e3a5f" }}>
                        Promo:{" "}
                        {o.promoCode ? (
                          <>
                            <strong>{o.promoCode.code}</strong> — {o.promoCode.label} ({o.promoCode.kind === "COOP" ? "Co-op" : "Coupon"})
                            {o.promoCode.kind === "COOP" && Number(o.coOpKickbackOwed || 0) > 0 ? (
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
                                  customerName: String(o.customer?.name || ""),
                                  customerEmail: String(o.customer?.email || ""),
                                  customerPhone: String(o.customer?.phone || ""),
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
                                }
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
                                to: "Order + invoice + payment will be permanently deleted."
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
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {activeTab === "Making" && (
        <section>
          <h2>Making</h2>
          <p style={{ marginTop: 0, maxWidth: 860, color: "#395946" }}>
            This tab converts pending orders into production demand. It totals recipe lbs, builds an ingredient shopping list, and suggests batch splits near 50 lb
            (60 stays 60; 70 becomes two 35s).
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
            <p style={{ marginTop: 0, fontSize: 12, color: "#64748b" }}>Add extra production targets; these are included in shopping + recipe book below.</p>
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
            <h3 style={{ marginTop: 0 }}>Shopping List (Ingredients Needed)</h3>
            {makingShoppingList.length === 0 ? (
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
                  {makingShoppingList.map((r) => (
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
            <h3 style={{ marginTop: 0 }}>Recipe Book (Batch Plan)</h3>
            <p style={{ marginTop: 0, fontSize: 12, color: "#64748b" }}>
              Recipe Book uses only Manual Make Planner lines (pending orders are not auto-added here).
            </p>
            {makingRecipeBook.length === 0 ? (
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
            <input
              placeholder="Search by phone, name, email, invoice #, date, amount..."
              value={archiveOrderSearch}
              onChange={(e) => setArchiveOrderSearch(e.target.value)}
              style={{ minWidth: 280, flex: "1 1 240px", padding: "8px 10px", borderRadius: 8, border: "1px solid #9ec1ac" }}
            />
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
                                  {o.promoCode.kind === "COOP" && Number(o.coOpKickbackOwed || 0) > 0 ? (
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 8 }}>
            <input type="date" value={expenseFilter.from} onChange={(e) => setExpenseFilter({ ...expenseFilter, from: e.target.value })} />
            <input type="date" value={expenseFilter.to} onChange={(e) => setExpenseFilter({ ...expenseFilter, to: e.target.value })} />
            <input placeholder="Search vendor/category/notes" value={expenseFilter.query} onChange={(e) => setExpenseFilter({ ...expenseFilter, query: e.target.value })} />
            <select value={expenseFilter.category} onChange={(e) => setExpenseFilter({ ...expenseFilter, category: e.target.value })}>
              <option value="">All Categories</option>
              {taxFriendlyExpenseCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() =>
                void runReadOnly(async () => {
                  await loadFinanceData();
                })
              }
            >
              Apply Filters
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(async () => {
                await apiPost("/operations/expenses", {
                  vendor: expenseForm.vendor.trim(),
                  category: expenseForm.category,
                  amount: Number(expenseForm.amount),
                  expenseDate: normalizeExpenseDateInput(expenseForm.expenseDate),
                  receiptPath: expenseForm.receiptPath.trim() || undefined,
                  notes: buildExpenseNotes(expenseForm.description, expenseForm.payment)
                });
                setExpenseForm({
                  vendor: "",
                  description: "",
                  category: "",
                  amount: "",
                  payment: "",
                  receiptPath: "",
                  expenseDate: localDateTimeInputValue()
                });
              });
            }}
          >
            <div style={{ border: "1px solid #d9e8de", borderRadius: 10, padding: 10, background: "#fbfefc", marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1.2fr", gap: 8, width: "100%", marginBottom: 8 }}>
                <input placeholder="Vendor/payee" value={expenseForm.vendor} onChange={(e) => setExpenseForm({ ...expenseForm, vendor: e.target.value })} required />
                <input placeholder="Amount" type="number" step="0.01" value={expenseForm.amount} onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })} required />
                <select value={expenseForm.category} onChange={(e) => setExpenseForm({ ...expenseForm, category: e.target.value })} required>
                  <option value="">Category</option>
                  {taxFriendlyExpenseCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  type="datetime-local"
                  value={expenseForm.expenseDate}
                  onChange={(e) => setExpenseForm({ ...expenseForm, expenseDate: e.target.value })}
                  title="Auto-filled with now; editable"
                  required
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, width: "100%" }}>
                <input placeholder="Description (optional)" value={expenseForm.description} onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })} />
                <input placeholder="Payment (optional)" value={expenseForm.payment} onChange={(e) => setExpenseForm({ ...expenseForm, payment: e.target.value })} />
                <input placeholder="Receipt URL/path (optional)" value={expenseForm.receiptPath} onChange={(e) => setExpenseForm({ ...expenseForm, receiptPath: e.target.value })} />
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      void submit(async () => {
                        const fd = new FormData();
                        fd.append("file", file);
                        const uploaded: any = await apiPostForm("/operations/expenses/upload", fd);
                        setExpenseForm((prev) => ({ ...prev, receiptPath: String(uploaded?.receiptPath || "") }));
                      }, {
                        title: "Confirm local receipt upload",
                        from: { receipt: expenseForm.receiptPath || "No receipt attached" },
                        to: { receipt: file.name }
                      });
                      e.currentTarget.value = "";
                    }}
                  />
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <button type="submit">Add Expense</button>
              <span style={{ fontSize: 12, color: "#4b5563" }}>
                Date/time auto-fills to now, and you can change it any time.
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
                  const receiptHref = resolveReceiptHref(details.receipt);
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
                    <td style={{ border: "1px solid #ccc", padding: 6 }}>
                      {isEditing ? (
                        <input value={expenseEditForm.vendor} onChange={(e) => setExpenseEditForm({ ...expenseEditForm, vendor: e.target.value })} />
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
                        <input value={expenseEditForm.receiptPath} onChange={(e) => setExpenseEditForm({ ...expenseEditForm, receiptPath: e.target.value })} />
                      ) : (
                        receiptHref ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            {isImageReceipt(receiptHref) && (
                              <img
                                src={receiptHref}
                                alt="Receipt preview"
                                style={{ width: 40, height: 40, objectFit: "cover", border: "1px solid #ddd", borderRadius: 4, cursor: "pointer" }}
                                onClick={() => setExpenseReceiptPreview({ href: receiptHref, isPdf: false, name: "Receipt image" })}
                              />
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                setExpenseReceiptPreview({
                                  href: receiptHref,
                                  isPdf: !isImageReceipt(receiptHref),
                                  name: isPdfReceipt(receiptHref) ? "Receipt PDF" : "Receipt preview"
                                })
                              }
                            >
                              Preview
                            </button>
                            <a href={receiptHref} target="_blank" rel="noreferrer">
                              Open
                            </a>
                          </div>
                        ) : (
                          details.receipt || "-"
                        )
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
                                  notes: buildExpenseNotes(expenseEditForm.description, expenseEditForm.payment)
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
                              receiptPath: details.receipt || ""
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
          <p>Profit is calculated as revenue minus expenses for the selected range.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <input type="date" value={financeRange.from} onChange={(e) => setFinanceRange({ ...financeRange, from: e.target.value })} />
            <input type="date" value={financeRange.to} onChange={(e) => setFinanceRange({ ...financeRange, to: e.target.value })} />
            <button type="button" onClick={() => void runReadOnly(loadFinanceData)}>
              Refresh
            </button>
          </div>
          <ul>
            <li>
              Revenue: <SignedMoney value={profitSummary.revenue} />
            </li>
            <li>
              Operating Expenses: <SignedMoney value={profitSummary.operatingExpenses} />
            </li>
            <li>
              Profit (Revenue - Expenses): <SignedMoney value={profitSummary.netProfit} />
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
              href={`${API}/uploads/invoices/DEMO-sample-invoice.pdf`}
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
            <strong>Coupon</strong> codes lower the customer&apos;s pre-tax total (tax is recalculated). <strong>Co-op</strong> codes keep full price and accrue a{" "}
            <strong>kickback</strong> per order so you can pay organizers. Codes are case-insensitive. Customers enter codes on <strong>Submit Order</strong>.
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
              placeholder="Label / co-op name"
              value={newPromoForm.label}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, label: e.target.value })}
            />
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              Type
              <select
                value={newPromoForm.kind}
                onChange={(e) => setNewPromoForm({ ...newPromoForm, kind: e.target.value as "COUPON" | "COOP" })}
              >
                <option value="COUPON">Coupon (customer discount)</option>
                <option value="COOP">Co-op (kickback tracking)</option>
              </select>
            </label>
            <input
              placeholder="Coupon: % off pre-tax"
              type="number"
              step="0.01"
              value={newPromoForm.discountPercent}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, discountPercent: e.target.value })}
              disabled={newPromoForm.kind !== "COUPON"}
            />
            <input
              placeholder="Coupon: $ off pre-tax"
              type="number"
              step="0.01"
              value={newPromoForm.discountFixed}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, discountFixed: e.target.value })}
              disabled={newPromoForm.kind !== "COUPON"}
            />
            <input
              placeholder="Co-op: kickback % of pre-tax"
              type="number"
              step="0.01"
              value={newPromoForm.kickbackPercent}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, kickbackPercent: e.target.value })}
              disabled={newPromoForm.kind !== "COOP"}
            />
            <input
              placeholder="Co-op: flat $ kickback / order"
              type="number"
              step="0.01"
              value={newPromoForm.kickbackFixed}
              onChange={(e) => setNewPromoForm({ ...newPromoForm, kickbackFixed: e.target.value })}
              disabled={newPromoForm.kind !== "COOP"}
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
                  if (!newPromoForm.label.trim()) throw new Error("Label / co-op name is required.");
                  const body: Record<string, unknown> = {
                    code: newPromoForm.code.trim(),
                    label: newPromoForm.label.trim(),
                    kind: newPromoForm.kind,
                    active: newPromoForm.active
                  };
                  if (newPromoForm.kind === "COUPON") {
                    if (newPromoForm.discountPercent !== "") body.discountPercent = Number(newPromoForm.discountPercent);
                    if (newPromoForm.discountFixed !== "") body.discountFixed = Number(newPromoForm.discountFixed);
                  } else {
                    if (newPromoForm.kickbackPercent !== "") body.kickbackPercent = Number(newPromoForm.kickbackPercent);
                    if (newPromoForm.kickbackFixed !== "") body.kickbackFixed = Number(newPromoForm.kickbackFixed);
                  }
                  if (newPromoForm.payeeNotes.trim()) body.payeeNotes = newPromoForm.payeeNotes.trim();
                  await apiPost("/operations/promo-codes", body);
                  const [pc, cs] = await Promise.all([
                    apiGet<any[]>("/operations/promo-codes"),
                    apiGet<any[]>("/operations/promo-codes/coop-summary")
                  ]);
                  setPromoCodes(pc);
                  setCoopSummary(cs);
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

          <h3 style={{ color: "#14532d" }}>Co-op kickbacks owed (from orders)</h3>
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
                      <td style={{ padding: "8px 10px", fontSize: 13, color: "#475569", maxWidth: 280 }}>
                        {row.payeeNotes || "—"}
                      </td>
                    </tr>
                  ))}
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
                  <th style={{ padding: "8px 10px" }}>Coupon % / $</th>
                  <th style={{ padding: "8px 10px" }}>Co-op % / $</th>
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
                      {p.kind === "COUPON" ? (
                        <>
                          {p.discountPercent != null ? <PctColored value={p.discountPercent} /> : "—"} /{" "}
                          {p.discountFixed != null ? <SignedMoney value={p.discountFixed} /> : "—"}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {p.kind === "COOP" ? (
                        <>
                          {p.kickbackPercent != null ? <PctColored value={p.kickbackPercent} /> : "—"} /{" "}
                          {p.kickbackFixed != null ? <SignedMoney value={p.kickbackFixed} /> : "—"}
                        </>
                      ) : (
                        "—"
                      )}
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
                {editingPromo.kind === "COUPON" ? (
                  <>
                    <input
                      placeholder="Discount %"
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
                  </>
                ) : (
                  <>
                    <input
                      placeholder="Kickback %"
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
                  </>
                )}
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    type="button"
                    onClick={() =>
                      void submit(async () => {
                        await apiPut(`/operations/promo-codes/${editingPromo.id}`, {
                          label: editingPromo.label,
                          payeeNotes: editingPromo.payeeNotes?.trim() || null,
                          discountPercent: editingPromo.kind === "COUPON" ? editingPromo.discountPercent : null,
                          discountFixed: editingPromo.kind === "COUPON" ? editingPromo.discountFixed : null,
                          kickbackPercent: editingPromo.kind === "COOP" ? editingPromo.kickbackPercent : null,
                          kickbackFixed: editingPromo.kind === "COOP" ? editingPromo.kickbackFixed : null
                        });
                        const [pc, cs] = await Promise.all([
                          apiGet<any[]>("/operations/promo-codes"),
                          apiGet<any[]>("/operations/promo-codes/coop-summary")
                        ]);
                        setPromoCodes(pc);
                        setCoopSummary(cs);
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
              { label: "Net after expenses", node: <SignedMoney value={reportSummary.netAfterExpenses} /> },
              { label: "Orders (active)", node: <span>{reportSummary.orderTotals.orders}</span> },
              { label: "Cancelled orders", node: <span>{reportSummary.cancelledOrderCount}</span> },
              { label: "Total lbs sold", node: <span>{reportSummary.orderTotals.lbs.toFixed(2)}</span> },
              { label: "Avg order value", node: <SignedMoney value={reportSummary.avgOrderValue} /> },
              { label: "Profit / lb", node: <SignedMoney value={reportSummary.profitPerLb} /> },
              { label: "Gross margin %", node: <PctColored value={reportSummary.marginPct} /> },
              { label: "Expense ratio %", node: <PctColored value={-reportSummary.expenseRatioPct} /> },
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
              <a href={`${API}/reports/expenses.csv`} target="_blank">
                Download Expenses CSV
              </a>
            </li>
            <li>
              <a href={`${API}/reports/orders.csv`} target="_blank">
                Download Orders CSV
              </a>
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
                Review the details below, then confirm or cancel.
              </p>
            </div>
            <div style={{ padding: 16, overflowY: "auto", flex: 1, background: "#fafdfb" }}>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "#64748b", marginBottom: 6 }}>BEFORE</div>
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    borderRadius: 10,
                    background: "#fff",
                    border: "1px solid #e2e8f0",
                    fontSize: 12,
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "#1e293b",
                    fontFamily: "ui-monospace, Consolas, monospace"
                  }}
                >
                  {confirmValue(confirmModal.from)}
                </pre>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "#166534", marginBottom: 6 }}>AFTER</div>
                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    borderRadius: 10,
                    background: "#ecfdf5",
                    border: "1px solid #a7f3d0",
                    fontSize: 12,
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "#14532d",
                    fontFamily: "ui-monospace, Consolas, monospace"
                  }}
                >
                  {confirmValue(confirmModal.to)}
                </pre>
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
                Confirm
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
