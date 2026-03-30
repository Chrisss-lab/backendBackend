import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, StreamableFile } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OrderStatus, PromoKind } from "../../domain/enums";
import { isPnlInventoryPurchaseExpenseCategory } from "../../domain/pnl-inventory-expense";
import { createHash, randomUUID } from "crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, extname, join, resolve } from "path";
import * as nodeIcal from "node-ical";
import type { VEvent } from "node-ical";
import { getExpensesUploadDir } from "../../paths";
import { StorageService } from "../../storage/storage.service";
import { computeDashboardAnalytics, DEFAULT_LIFETIME_PRIOR, overlayLifetimeStatsFromCalculatorTotals } from "./dashboard-analytics.compute";

export type WorkersIcsEventDto = {
  id: string;
  uid: string;
  title: string;
  date: string;
  time: string;
  allDay: boolean;
  start: string;
  end: string;
  description: string;
  location: string;
  sourceFile: string;
};

@Injectable()
export class OperationsService implements OnModuleInit {
  private readonly logger = new Logger(OperationsService.name);
  private readonly njSalesTaxPct = 6.625;

  private get sheetUrl() {
    return String(this.config.get<string>("GOOGLE_SHEET_APPS_SCRIPT_URL") || "").trim();
  }
  private get sheetApiKey() {
    return String(this.config.get<string>("GOOGLE_SHEET_API_KEY") || "").trim();
  }
  private get sheetSiteKey() {
    return String(this.config.get<string>("GOOGLE_SHEET_SITE_KEY") || "").trim();
  }

  /** Operations data lives in Google Sheet + Drive (Apps Script). */
  private sheetOpsEnabled(): boolean {
    return Boolean(this.sheetUrl && (this.sheetSiteKey || this.sheetApiKey));
  }

  private requireSheetOps(): void {
    if (!this.sheetOpsEnabled()) {
      throw new BadRequestException(
        "Configure GOOGLE_SHEET_APPS_SCRIPT_URL and GOOGLE_SHEET_SITE_KEY or GOOGLE_SHEET_API_KEY for operations."
      );
    }
  }

  private sheetAuthPayload() {
    return this.sheetSiteKey ? { siteKey: this.sheetSiteKey } : { apiKey: this.sheetApiKey };
  }

  private async sheetGet<T = any>(action: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.sheetUrl);
    url.searchParams.set("action", action);
    const auth = this.sheetSiteKey ? { siteKey: this.sheetSiteKey } : { apiKey: this.sheetApiKey };
    for (const [k, v] of Object.entries({ ...query, ...auth })) {
      if (!v) continue;
      url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), { method: "GET" });
    const data = await res.json();
    if (!res.ok || data?.ok === false) {
      const err = String(data?.error || `Sheet GET ${action} failed`);
      if (action === "pull" && /unknown action:\s*pull/i.test(err)) {
        throw new BadRequestException(
          "Apps Script URL is not the controller deployment (it returned Unknown action: pull). Deploy the updated Code.gs web app and set GOOGLE_SHEET_APPS_SCRIPT_URL to that /exec URL."
        );
      }
      throw new BadRequestException(err);
    }
    return data as T;
  }

  private async sheetPost<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    const body = { action, ...this.sheetAuthPayload(), ...payload };
    const res = await fetch(this.sheetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok || data?.ok === false) {
      const err = String(data?.error || `Sheet POST ${action} failed`);
      throw new BadRequestException(err);
    }
    return data as T;
  }

  private async sheetPullAll() {
    const data = await this.sheetGet<any>("pull");
    return data;
  }

  /** True when the API reads/writes the Google Sheet instead of Prisma. */
  usesSheetBackend(): boolean {
    return this.sheetOpsEnabled();
  }

  /** Promo codes persisted in sheet Settings tab (JSON array). */
  private readonly sheetPromoCodesSettingKey = "JR_PROMO_CODES_JSON";

  private async sheetReadPromoCodes(): Promise<any[]> {
    const data = await this.sheetPullAll();
    const settings = (data as any).settings || {};
    const raw = String(settings[this.sheetPromoCodesSettingKey] || "").trim();
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      this.logger.warn("JR_PROMO_CODES_JSON could not be parsed; treating as empty.");
      return [];
    }
  }

  private async sheetWritePromoCodes(rows: any[]): Promise<void> {
    await this.sheetPost("setSetting", {
      key: this.sheetPromoCodesSettingKey,
      value: JSON.stringify(rows)
    });
  }

  /** Manual make planner lines + optional notes (Making tab). */
  private readonly sheetMakingPlanSettingKey = "JR_MAKING_PLAN_JSON";

  private readMakingPlanFromSettings(data: any): { lines: Array<{ recipeId: string; amountLbs: string }>; notes: string } {
    const settings = (data as any).settings || {};
    const raw = String(settings[this.sheetMakingPlanSettingKey] || "").trim();
    const fallbackLine = () => [{ recipeId: "", amountLbs: "" }];
    if (!raw) return { lines: fallbackLine(), notes: "" };
    try {
      const parsed = JSON.parse(raw);
      const linesIn = Array.isArray(parsed.lines) ? parsed.lines : [];
      const lines = linesIn.map((x: any) => ({
        recipeId: String(x.recipeId ?? ""),
        amountLbs: String(x.amountLbs ?? "")
      }));
      return {
        lines: lines.length ? lines : fallbackLine(),
        notes: parsed.notes != null ? String(parsed.notes) : ""
      };
    } catch {
      this.logger.warn("JR_MAKING_PLAN_JSON could not be parsed; using empty plan.");
      return { lines: fallbackLine(), notes: "" };
    }
  }

  /** Snapshot of Making + RecipeBook_Auto + Shopping_Auto + BatchPlan_Auto + Totals_Auto from the sheet. */
  getMakingEngine(): Promise<Record<string, unknown>> {
    this.requireSheetOps();
    return this.sheetGet<Record<string, unknown>>("makingEngine");
  }

  getMakingPlan(): Promise<{ lines: Array<{ recipeId: string; amountLbs: string }>; notes: string }> {
    this.requireSheetOps();
    return (async () => {
      try {
        const eng = await this.sheetGet<any>("makingEngine");
        if (eng?.ok && Array.isArray(eng.making) && eng.making.length) {
          const lines = eng.making.map((r: any) => ({
            recipeId: String(r.recipeId || ""),
            amountLbs: String(r.targetLbs ?? "")
          }));
          let notes = "";
          for (const r of eng.making) {
            const n = String(r.notes || "").trim();
            if (n) {
              notes = n;
              break;
            }
          }
          const data = await this.sheetPullAll();
          const fromSettings = this.readMakingPlanFromSettings(data);
          if (fromSettings.notes) notes = fromSettings.notes;
          return { lines, notes };
        }
      } catch (e: any) {
        this.logger.warn(`makingEngine unavailable: ${e?.message || e}; using JR_MAKING_PLAN_JSON`);
      }
      const data = await this.sheetPullAll();
      return this.readMakingPlanFromSettings(data);
    })();
  }

  saveMakingPlan(body: {
    lines?: Array<{ recipeId?: string; amountLbs?: string }>;
    notes?: string;
  }) {
    this.requireSheetOps();
    const mapped = (body.lines || [])
      .map((x) => ({
        recipeId: String(x.recipeId || "").trim(),
        amountLbs: String(x.amountLbs ?? "").trim()
      }))
      .filter((x) => x.recipeId || x.amountLbs);
    const lines = mapped.length ? mapped : [{ recipeId: "", amountLbs: "" }];
    const notes = body.notes != null ? String(body.notes) : "";
    const readyLines = mapped
      .filter((x) => x.recipeId && Number(x.amountLbs || 0) > 0)
      .map((x) => ({
        recipeId: x.recipeId,
        targetLbs: Number(x.amountLbs),
        amountLbs: x.amountLbs
      }));

    return (async () => {
      await this.sheetPost("replaceMaking", { lines: readyLines, notes, maxBatchLbs: 50 });
      await this.sheetPost("setSetting", {
        key: this.sheetMakingPlanSettingKey,
        value: JSON.stringify({ lines, notes })
      });
      return { ok: true as const };
    })();
  }

  private buildRecipePlansFromBatchPlanAuto(rows: any[]) {
    const byR: Record<string, { recipeId: string; recipeName: string; batchMap: Map<number, number> }> = {};
    for (const r of rows || []) {
      const rid = String(r.recipeId || "").trim();
      if (!rid) continue;
      if (!byR[rid]) byR[rid] = { recipeId: rid, recipeName: String(r.recipeName || ""), batchMap: new Map<number, number>() };
      const bn = Number(r.batchNo);
      const bl = Number(r.batchLbs);
      if (bn > 0 && bl > 0) byR[rid].batchMap.set(bn, bl);
    }
    return Object.values(byR).map((x) => {
      const order = [...x.batchMap.keys()].sort((a, b) => a - b);
      const batches = order.map((k) => x.batchMap.get(k) || 0);
      const totalLbs = batches.reduce((s, v) => s + v, 0);
      return { recipeId: x.recipeId, recipeName: x.recipeName, totalLbs, batches };
    });
  }

  computeMakingPlan(body: {
    lines?: Array<{ recipeId?: string; amountLbs?: string }>;
    maxBatchLbs?: number;
  }) {
    this.requireSheetOps();
    const mapped = (body.lines || [])
      .map((x) => ({
        recipeId: String(x.recipeId || "").trim(),
        amountLbs: String(x.amountLbs ?? "").trim()
      }))
      .filter((x) => x.recipeId && Number(x.amountLbs || 0) > 0);
    const maxB = Number(body.maxBatchLbs || 50);
    return (async () => {
      await this.sheetPost("replaceMaking", {
        lines: mapped.map((x) => ({ recipeId: x.recipeId, targetLbs: Number(x.amountLbs), amountLbs: x.amountLbs })),
        maxBatchLbs: maxB
      });
      const eng = await this.sheetGet<any>("makingEngine");
      const recipePlans = this.buildRecipePlansFromBatchPlanAuto(eng.batchPlanAuto || []);
      const ingredientTotals = (eng.shoppingAuto || [])
        .map((r: any) => ({
          ingredientName: String(r.ingredientName || ""),
          needLbs: Number(r.neededLbs || 0),
          onHandLbs: Number(r.onHandLbs || 0),
          buyLbs: Number(r.buyLbs || 0)
        }))
        .filter((r: { needLbs: number }) => r.needLbs > 1e-9);
      return {
        ok: true,
        source: "sheet",
        maxBatchLbs: maxB,
        recipePlans,
        ingredientTotals,
        recipeBookAuto: eng.recipeBookAuto,
        shoppingAuto: eng.shoppingAuto,
        batchPlanAuto: eng.batchPlanAuto,
        totalsAuto: eng.totalsAuto,
        making: eng.making
      };
    })();
  }

  private productIngredientPairsFromSheetRow(row: Record<string, unknown>): Array<{ name: string; ratio: number }> {
    const pairs: Array<{ name: string; ratio: number }> = [];
    for (const k of Object.keys(row || {})) {
      const m = /^ingredient (\d+)$/i.exec(String(k).trim());
      if (!m) continue;
      const idx = m[1];
      const name = String(row[`ingredient ${idx}`] ?? "").trim();
      const ratio = this.normalizeRecipeRatioPercent(row[`ingredient ${idx} ratio`]);
      if (!name || !(ratio > 0)) continue;
      pairs.push({ name, ratio });
    }
    return pairs.sort((a, b) => b.ratio - a.ratio);
  }

  private normalizeSheetOrdersFromPull(data: any): any[] {
    const products: any[] = data.products || [];
    const customers: any[] = data.customers || [];
    const payments: any[] = data.payments || [];
    const productById = new Map<string, any>(products.map((p: any) => [String(p.id || "").trim(), p]));
    const productByName = new Map<string, any>();
    for (const p of products) {
      const k = String(p.name || "").trim().toLowerCase();
      if (k) productByName.set(k, p);
    }
    const customerByPhone = new Map<string, any>();
    const customerByEmail = new Map<string, any>();
    for (const c of customers) {
      const ph = String(c.phone || "").replace(/\D/g, "");
      if (ph) customerByPhone.set(ph, c);
      const em = String(c.email || "").trim().toLowerCase();
      if (em) customerByEmail.set(em, c);
    }
    const paymentsByOrder = new Map<string, any[]>();
    for (const p of payments) {
      const oid = String(p.orderId || "").trim();
      if (!oid) continue;
      const arr = paymentsByOrder.get(oid) || [];
      arr.push(p);
      paymentsByOrder.set(oid, arr);
    }
    const taxFactor = 1 + this.njSalesTaxPct / 100;

    const resolveCustomer = (order: any) => {
      const ph = String(order.phone || "").replace(/\D/g, "");
      const em = String(order.email || "").trim().toLowerCase();
      let c: any = null;
      if (ph) c = customerByPhone.get(ph) || null;
      if (!c && em) c = customerByEmail.get(em) || null;
      const customerId = c ? String(c.id) : `sheet:${ph || em || order.id}`;
      const customer = c
        ? { id: c.id, name: c.name, email: c.email ?? null, phone: c.phone ?? null, address: c.address ?? null }
        : {
            id: customerId,
            name: String(order.customerName || "").trim() || "Customer",
            email: order.email || null,
            phone: order.phone || null,
            address: order.address || null
          };
      return { customerId, customer };
    };

    const parseLines = (order: any): Array<{ productId: string; productName: string; qtyLbs: number }> => {
      const raw = String(order.orderItemsJson || "").trim();
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length) {
            const out: Array<{ productId: string; productName: string; qtyLbs: number }> = [];
            for (const line of arr) {
              const pid = String(line.productId || line.recipeId || "").trim();
              const pname = String(line.productName || line.recipeName || "").trim();
              const q = Number(line.quantity ?? line.quantityLbs ?? 0);
              const qUnit = String(line.quantityUnit || "lb").toLowerCase();
              let prod = pid ? productById.get(pid) : undefined;
              if (!prod && pname) prod = productByName.get(pname.toLowerCase());
              const amountPerUnit = Math.max(0.0001, Number(prod?.amountPerUnit ?? 1));
              const qtyLbs = qUnit === "lb" ? q : q * amountPerUnit;
              const name = pname || String(prod?.name || "").trim();
              if (!(qtyLbs > 0) || !name) continue;
              out.push({ productId: pid || String(prod?.id || "").trim(), productName: name, qtyLbs });
            }
            if (out.length) return out;
          }
        } catch {
          /* fall through */
        }
      }
      const recipe = String(order.recipe || "").trim();
      const lbs = Number(order.quantityLbs || 0);
      return recipe && lbs > 0 ? [{ productId: "", productName: recipe, qtyLbs: lbs }] : [];
    };

    const lineCogsAndLbs = (lines: ReturnType<typeof parseLines>) => {
      let cogs = 0;
      let lbs = 0;
      for (const ln of lines) {
        let prod = ln.productId ? productById.get(ln.productId) : undefined;
        if (!prod && ln.productName) prod = productByName.get(ln.productName.toLowerCase());
        const cpl = prod ? Number(prod.costPerLb ?? prod.cost ?? 0) : 0;
        cogs += cpl * ln.qtyLbs;
        lbs += ln.qtyLbs;
      }
      return { cogs, lbs };
    };

    const mapRow = (r: any, bucket: "pending" | "archive") => {
      const stRaw = String(r.status || "").toUpperCase();
      let status: string;
      if (bucket === "pending") {
        status = stRaw === "CANCELLED" ? "CANCELLED" : "NEW";
      } else {
        if (stRaw === "CANCELLED") status = "CANCELLED";
        else if (stRaw === "FULFILLED" || stRaw === "COMPLETED") status = "FULFILLED";
        else status = "FULFILLED";
      }
      const lines = parseLines(r);
      const { cogs, lbs } = lineCogsAndLbs(lines);
      const subtotal = Number(r.subtotalTaxIncl ?? r.subtotal ?? 0);
      const netRev = subtotal > 0 ? subtotal / taxFactor : 0;
      const margin = netRev - cogs;
      const { customerId, customer } = resolveCustomer(r);
      const payList = paymentsByOrder.get(String(r.id || "")) || [];
      const primaryPay = [...payList].sort((a, b) =>
        String(b.paidAt || b.createdAt || "").localeCompare(String(a.paidAt || a.createdAt || ""))
      )[0];
      const paySt = String(primaryPay?.status || "").toUpperCase();
      const paidAt = primaryPay && paySt === "PAID" ? primaryPay.paidAt || primaryPay.updatedAt || null : null;
      const paymentStatus = primaryPay ? primaryPay.status : "UNPAID";

      const uiJson = JSON.stringify(
        lines.map((ln) => ({
          recipeName: ln.productName,
          quantityLbs: ln.qtyLbs,
          productId: ln.productId,
          productName: ln.productName,
          quantity: ln.qtyLbs,
          quantityUnit: "lb"
        }))
      );

      let recipe: { id: string; name: string } | null = null;
      let recipeId: string | null = null;
      const first = lines[0];
      if (first) {
        let prod = first.productId ? productById.get(first.productId) : undefined;
        if (!prod && first.productName) prod = productByName.get(first.productName.toLowerCase());
        if (prod) {
          recipeId = String(prod.id);
          recipe = { id: String(prod.id), name: String(prod.name || "") };
        } else if (first.productName) {
          recipe = { id: "", name: first.productName };
        }
      }

      const invoice =
        r.invoiceNumber || primaryPay
          ? {
              id: String(primaryPay?.id || `sheet-inv:${r.id}`),
              invoiceNumber: String(r.invoiceNumber || primaryPay?.invoiceNumber || ""),
              amount: Number(primaryPay?.amount ?? subtotal),
              pdfPath: r.invoiceUrl || null,
              payment: {
                status: String(primaryPay?.status || "UNPAID").toUpperCase(),
                amount: Number(primaryPay?.amount || 0),
                paidAt: primaryPay?.paidAt || null
              }
            }
          : null;

      const sheetLbs = Number(r.quantityLbs || 0);
      return {
        ...r,
        subtotal,
        quantityLbs: lbs > 0 ? lbs : sheetLbs,
        cogs,
        margin,
        status,
        customerId,
        customer,
        recipeId,
        recipe,
        orderItemsJson: lines.length ? uiJson : String(r.orderItemsJson || "[]"),
        paidAt,
        paymentStatus,
        invoice,
        preTaxNet: netRev,
        sheetBucket: bucket
      };
    };

    const pending = (data.pending || []).map((r: any) => mapRow(r, "pending"));
    const archive = (data.archive || []).map((r: any) => mapRow(r, "archive"));
    return [...pending, ...archive].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  private mapSheetProductsToRecipes(data: any): any[] {
    const ingredients: any[] = data.ingredients || [];
    const inv: any[] = data.inventory || [];
    const ingByName = new Map<string, any>();
    for (const i of ingredients) {
      const k = String(i.name || "").trim().toLowerCase();
      if (k) ingByName.set(k, i);
    }
    const qtyByIngId = new Map<string, number>();
    const qtyByName = new Map<string, number>();
    for (const lot of inv) {
      const id = String(lot.ingredientId || "").trim();
      const q = Number(lot.quantityOnHand || 0);
      if (id) qtyByIngId.set(id, (qtyByIngId.get(id) || 0) + q);
      const n = String(lot.ingredientName || "").trim().toLowerCase();
      if (n) qtyByName.set(n, (qtyByName.get(n) || 0) + q);
    }

    return (data.products || []).map((p: any) => {
      const rowObj = p as Record<string, unknown>;
      const pairs = this.productIngredientPairsFromSheetRow(rowObj);
      const recipeIngredients = pairs.map((pair) => {
        const ing: any = ingByName.get(pair.name.toLowerCase());
        const ingId = ing ? String(ing.id || "").trim() : "";
        const onHand = ing
          ? (qtyByIngId.get(ingId) || qtyByName.get(pair.name.toLowerCase()) || 0)
          : qtyByName.get(pair.name.toLowerCase()) || 0;
        const defaultCost = Number(ing?.defaultCost || 0);
        const chargePu = Number(ing?.chargePerUnit || 0);
        return {
          ingredientId: ingId || pair.name,
          quantity: pair.ratio,
          ingredient: {
            id: ingId || null,
            name: pair.name,
            unit: String(ing?.unit || "lb"),
            quantityOnHand: onHand,
            pricePerLb: defaultCost,
            chargePerPound: chargePu,
            defaultCost,
            category: ing?.category
          }
        };
      });
      const unit = String(p.chargeUnit || p.unit || "lb");
      const amountPerUnit = Math.max(0.01, Number(p.amountPerUnit || 1));
      const salePrice = Number(p.price || 0);
      const costPerPound = Number(p.costPerLb ?? p.cost ?? 0);
      return {
        ...p,
        salePrice,
        costPerPound,
        chargeUnit: unit,
        amountPerUnit,
        foodType: p.foodType || "Adult",
        description: p.description || "",
        isBundle: String(p.isBundle ?? "false").toLowerCase() === "true",
        ingredients: recipeIngredients,
        bundleItems: []
      };
    });
  }

  private mapSheetIngredientsMerged(data: any): any[] {
    const inv: any[] = data.inventory || [];
    const byIngId = new Map<string, number>();
    const byName = new Map<string, number>();
    for (const row of inv) {
      const q = Number(row.quantityOnHand || 0);
      const id = String(row.ingredientId || "").trim();
      if (id) byIngId.set(id, (byIngId.get(id) || 0) + q);
      const n = String(row.ingredientName || "").trim().toLowerCase();
      if (n) byName.set(n, (byName.get(n) || 0) + q);
    }
    return (data.ingredients || []).map((ing: any) => {
      const id = String(ing.id || "").trim();
      const nm = String(ing.name || "").trim().toLowerCase();
      const onHand = (id ? byIngId.get(id) : 0) || (nm ? byName.get(nm) : 0) || 0;
      const defaultCost = Number(ing.defaultCost || 0);
      const chargePu = Number(ing.chargePerUnit || 0);
      return {
        ...ing,
        pricePerLb: defaultCost,
        chargePerPound: chargePu,
        quantityOnHand: onHand,
        totalCost: onHand * defaultCost,
        percentAdded: 0,
        markupPercent: defaultCost > 0 ? ((chargePu - defaultCost) / defaultCost) * 100 : 0
      };
    });
  }

  /** Ratios with '%' are literal percent; tiny bare decimals (e.g. 0.0025) are decimal fractions -> percent. */
  private normalizeRecipeRatioPercent(raw: unknown): number {
    if (typeof raw === "string") {
      const s = raw.trim();
      if (!s) return 0;
      const hasPercentSign = s.includes("%");
      const numeric = Number(s.replace(/%/g, "").replace(",", ".").trim());
      if (!Number.isFinite(numeric) || numeric <= 0) return 0;
      if (hasPercentSign) return numeric;
      return numeric < 0.01 ? numeric * 100 : numeric;
    }
    const n = Number(raw || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 0.01 ? n * 100 : n;
  }

  constructor(
    private readonly config: ConfigService,
    private readonly storage: StorageService
  ) {}

  async onModuleInit() {
    if (this.sheetOpsEnabled()) {
      this.logger.log("Operational backend: Google Sheet + Drive.");
    } else {
      this.logger.warn(
        "Google Sheet URL/key not configured — configure GOOGLE_SHEET_APPS_SCRIPT_URL and GOOGLE_SHEET_SITE_KEY or GOOGLE_SHEET_API_KEY."
      );
    }
  }

  /**
   * Uploads receipt images/PDFs to Google Drive (Apps Script RECEIPTS_FOLDER_ID).
   * Drive file names include date, vendor, description, category, amount, and payment for search.
   */
  async uploadExpenseReceiptsBatch(expenseId: string, files: Express.Multer.File[]) {
    this.requireSheetOps();
    if (!files?.length) throw new BadRequestException("No files uploaded.");
    const filePayloads = files.map((file) => ({
      base64Data: file.buffer.toString("base64"),
      mimeType: file.mimetype || "application/octet-stream",
      sha256: createHash("sha256").update(file.buffer).digest("hex")
    }));
    return this.sheetPost<{
      ok: boolean;
      uploaded: number;
      files: Array<{ ok?: boolean; url?: string; fileId?: string; duplicate?: boolean; skipped?: boolean; fileName?: string }>;
      errors: Array<{ index: number; error: string }>;
    }>("uploadExpenseReceiptsBatch", { rowId: expenseId, files: filePayloads });
  }

  /**
   * Single-file upload. Requires `expenseId` query so the file can be stored in Drive and linked on the expense row.
   */
  async saveExpenseReceiptUpload(file: Express.Multer.File, expenseId?: string): Promise<{ receiptPath: string }> {
    if (!file?.buffer?.length) throw new BadRequestException("Empty file.");
    const id = String(expenseId || "").trim();
    if (!id) {
      throw new BadRequestException(
        "Receipts are saved to your Google Drive receipt folder (Apps Script). Add the expense first, then attach photos (use “Choose files” — multiple allowed), or pass expenseId as a query parameter on this upload URL."
      );
    }
    const res = await this.uploadExpenseReceiptsBatch(id, [file]);
    const urls = (res.files || []).map((x) => x.url).filter(Boolean) as string[];
    const path = urls.join(" | ");
    if (!path && (res.errors || []).length) throw new BadRequestException(String(res.errors[0]?.error || "Upload failed."));
    return { receiptPath: path };
  }

  /** Stream a receipt stored under uploads/expenses (local mode only). */
  getExpenseReceiptFileStream(filename: string): StreamableFile {
    let decoded = String(filename || "").trim();
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw new BadRequestException("Invalid receipt file.");
    }
    const safe = basename(decoded);
    if (safe !== decoded || safe.includes("..") || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i.test(safe)) {
      throw new BadRequestException("Invalid receipt file.");
    }
    const dir = resolve(getExpensesUploadDir());
    const full = resolve(dir, safe);
    if (!full.startsWith(dir) || !existsSync(full)) throw new NotFoundException("Receipt not found.");
    const lower = safe.toLowerCase();
    const type = lower.endsWith(".pdf")
      ? "application/pdf"
      : lower.endsWith(".png")
        ? "image/png"
        : lower.endsWith(".webp")
          ? "image/webp"
          : lower.endsWith(".gif")
            ? "image/gif"
            : "image/jpeg";
    const stream = createReadStream(full);
    return new StreamableFile(stream, { type: type, disposition: `inline; filename="${safe}"` });
  }

  private absolutizeReceiptPublicUrl(pathOrUrl: string): string {
    const raw = String(pathOrUrl || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    const pub = (this.config.get<string>("PUBLIC_API_BASE_URL") || "").trim().replace(/\/$/, "");
    if (!pub) return raw.startsWith("/") ? raw : `/${raw}`;
    return `${pub}${raw.startsWith("/") ? "" : "/"}${raw}`;
  }

  private normalizeExpenseCategory(input: string, context?: string) {
    const raw = `${input || ""} ${context || ""}`.trim().toLowerCase();
    if (!raw) return "Other";

    // Returns/refunds stay visible but grouped safely for reporting.
    if (raw.includes("return") || raw.includes("refund") || raw.includes("credit")) return "Other";

    // Core inventory spending.
    if (
      raw.includes("food") ||
      raw.includes("ingredient") ||
      raw.includes("meat") ||
      raw.includes("broth") ||
      raw.includes("kelp") ||
      raw.includes("oil") ||
      raw.includes("powder")
    ) {
      return "Inventory - Meat";
    }

    // Packaging and label supplies.
    if (raw.includes("packag") || raw.includes("label") || raw.includes("container") || raw.includes("bag")) return "Packaging";

    // Repairs, tools, machines, and parts are treated as equipment/asset support.
    if (
      raw.includes("equip") ||
      raw.includes("equpment") ||
      raw.includes("manufacturing") ||
      raw.includes("repair") ||
      raw.includes("parts") ||
      raw.includes("tool") ||
      raw.includes("compressor") ||
      raw.includes("motor") ||
      raw.includes("wire")
    ) {
      return "Equipment";
    }

    // Sanitation and cleaning chemicals/supplies.
    if (raw.includes("clean")) return "Utilities";

    // Compliance, taxes, filings, and accounting.
    if (
      raw.includes("legal") ||
      raw.includes("tax") ||
      raw.includes("license") ||
      raw.includes("dmv") ||
      raw.includes("state") ||
      raw.includes("account")
    ) {
      return "Professional Fees";
    }

    if (raw.includes("insur")) return "Insurance";
    if (raw.includes("advert") || raw.includes("marketing") || raw.includes("facebook") || raw.includes("vista")) return "Marketing";
    if (raw.includes("rent")) return "Rent";
    if (raw.includes("ship") || raw.includes("postal") || raw.includes("ups") || raw.includes("usps") || raw.includes("coop")) {
      return "Shipping/Delivery";
    }
    if (raw.includes("misc")) return "Other";
    return "Other";
  }

  listDashboard() {
    this.requireSheetOps();
    return this.listOrders();
  }

  async getOverview() {
    this.requireSheetOps();
    const s = await this.sheetGet<any>("summary");
    return {
      customerCount: Number(s?.counts?.customers || 0),
      orderCount: Number(s?.counts?.pending || 0) + Number(s?.counts?.archive || 0),
      expenseCount: Number(s?.counts?.expenses || 0),
      recipeCount: Number(s?.counts?.products || 0),
      ingredientCount: Number(s?.counts?.ingredients || 0)
    };
  }

  private normalizeInvoicesFromPull(data: any): any[] {
    const payments = data.payments || [];
    const pending = data.pending || [];
    const archive = data.archive || [];
    const byId = new Map<string, any>();
    for (const o of [...pending, ...archive]) byId.set(String(o.id || ""), o);
    return payments.map((p: any) => {
      const o = byId.get(String(p.orderId || ""));
      return {
        id: p.id,
        invoiceNumber: p.invoiceNumber || "",
        amount: Number(p.amount || 0),
        orderId: p.orderId || "",
        createdAt: p.createdAt || p.updatedAt || new Date().toISOString(),
        payment: {
          status: p.status || "UNPAID",
          amount: Number(p.amount || 0),
          paidAt: p.paidAt || null
        },
        order: o
          ? {
              id: o.id,
              customer: {
                name: o.customerName,
                email: o.email,
                phone: o.phone
              }
            }
          : null
      };
    });
  }

  private readPromoCodesFromPullData(data: any): any[] {
    const settings = (data as any).settings || {};
    const raw = String(settings[this.sheetPromoCodesSettingKey] || "").trim();
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      this.logger.warn("JR_PROMO_CODES_JSON could not be parsed; treating as empty.");
      return [];
    }
  }

  private readKickbackPaymentsFromPullData(data: any): any[] {
    const rows = (data as any).kickbackPayments;
    if (!Array.isArray(rows)) return [];
    return rows.map((r: any) => ({
      ...r,
      amountPaid: Number(r.amountPaid ?? 0)
    }));
  }

  private readMakingPlanFromPullData(data: any): {
    lines: Array<{ recipeId: string; amountLbs: string }>;
    notes: string;
  } {
    const settings = (data as any).settings || {};
    const raw = String(settings[this.sheetMakingPlanSettingKey] || "").trim();
    const fallbackLine = () => [{ recipeId: "", amountLbs: "" }];
    if (!raw) return { lines: fallbackLine(), notes: "" };
    try {
      const parsed = JSON.parse(raw);
      const linesIn = Array.isArray(parsed.lines) ? parsed.lines : [];
      const lines = linesIn.map((x: any) => ({
        recipeId: String(x.recipeId ?? ""),
        amountLbs: String(x.amountLbs ?? "")
      }));
      return {
        lines: lines.length ? lines : fallbackLine(),
        notes: parsed.notes != null ? String(parsed.notes) : ""
      };
    } catch {
      this.logger.warn("JR_MAKING_PLAN_JSON could not be parsed; using empty plan.");
      return { lines: fallbackLine(), notes: "" };
    }
  }

  /** Same math as `ReportsService.pnlSummary` for sheet-backed orders/expenses (single pull). */
  private computePnlSummaryFromOrdersExpenses(orders: any[], expenses: any[]) {
    const pnlExclude = new Set(
      ["Meats", "Organs", "Dairy", "Fruits/Veggies", "Fruits / Veggies", "Fats", "Supplements", "Packaging"].map((c) => c.toLowerCase())
    );
    const taxFactor = 1 + 0.06625;
    let revenue = 0;
    let netSales = 0;
    let cogs = 0;
    for (const o of orders) {
      if (String(o.status) === "CANCELLED") continue;
      const sub = Number(o.subtotal || 0);
      revenue += sub;
      netSales += sub > 0 ? sub / taxFactor : 0;
      cogs += Number(o.cogs || 0);
    }
    let operating = 0;
    let inventoryPurchases = 0;
    for (const e of expenses) {
      const amt = Number(e.amount ?? 0);
      if (isPnlInventoryPurchaseExpenseCategory(e.category)) inventoryPurchases += amt;
      else operating += amt;
    }
    const expenseTotalAll = operating + inventoryPurchases;
    const grossProfit = netSales - cogs;
    const netProfit = netSales - cogs - operating;
    const byCategoryMap = new Map<string, number>();
    for (const e of expenses) {
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
      expenses: operating,
      expensesTotal: expenseTotalAll,
      expensesInventoryPurchases: inventoryPurchases,
      netProfit,
      expensesByCategory
    };
  }

  private parseWeeksBack(raw?: number): 8 | 12 | 26 {
    const n = Number(raw);
    return [8, 12, 26].includes(n) ? (n as 8 | 12 | 26) : 8;
  }

  /**
   * One sheet pull (+ summary) returns normalized hub entities and precomputed dashboard analytics.
   * Replaces many parallel /operations/* calls that each called sheetPullAll.
   */
  async hubBootstrap(params: { weeksBack?: number; reportFrom?: string; reportTo?: string }) {
    this.requireSheetOps();
    const weeksBack = this.parseWeeksBack(params.weeksBack);
    const [pull, summary, totalsRaw] = await Promise.all([
      this.sheetPullAll(),
      this.sheetGet<any>("summary"),
      this.sheetGet<any>("totals").catch(() => null)
    ]);
    const customers = pull.customers || [];
    const ingredients = this.mapSheetIngredientsMerged(pull);
    const recipes = this.mapSheetProductsToRecipes(pull).filter((r: any) => String(r.active ?? "true").toLowerCase() !== "false");
    const inventory = (pull.inventory || []).map((r: any) => ({
      ...r,
      ingredient: String(r.ingredientName || r.productName || r.ingredient || ""),
      quantityLbs: Number(r.quantityOnHand ?? r.quantityLbs ?? 0)
    }));
    const orders = this.normalizeSheetOrdersFromPull(pull);
    const expenses = (pull.expenses || []).map((e: any) => ({
      ...e,
      receiptPath: e.receiptPath || e.receiptUrl || ""
    }));
    const invoices = this.normalizeInvoicesFromPull(pull);
    const promoCodes = [...this.readPromoCodesFromPullData(pull)].sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
    const kickbackPayments = this.readKickbackPaymentsFromPullData(pull);
    const makingPlan = this.readMakingPlanFromPullData(pull);
    const totals = totalsRaw && totalsRaw.totals ? totalsRaw.totals : {};
    const overview = {
      customerCount: Number(summary?.counts?.customers || 0),
      orderCount: Number(summary?.counts?.pending || 0) + Number(summary?.counts?.archive || 0),
      expenseCount: Number(summary?.counts?.expenses || 0),
      recipeCount: Number(summary?.counts?.products || 0),
      ingredientCount: Number(summary?.counts?.ingredients || 0)
    };
    if (totals && typeof totals === "object") {
      const t = totals as Record<string, unknown>;
      overview.customerCount = Number(t.snapshot_customers_count ?? overview.customerCount);
      overview.orderCount = Number(t.snapshot_orders_total_count ?? overview.orderCount);
      overview.expenseCount = Number(t.snapshot_expense_rows_count ?? overview.expenseCount);
      overview.recipeCount = Number(t.snapshot_products_count ?? overview.recipeCount);
      overview.ingredientCount = Number(
        t.snapshot_ingredients_count ?? t.snapshot_ingredient_inv_rows ?? overview.ingredientCount
      );
    }
    const pnl = this.computePnlSummaryFromOrdersExpenses(orders, expenses);
    let dashboardAnalytics = computeDashboardAnalytics({
      orders,
      expenses,
      recipes,
      invoices,
      inventory,
      customers,
      ingredients,
      reportFrom: String(params.reportFrom ?? ""),
      reportTo: String(params.reportTo ?? ""),
      weeksBack,
      lifetimePrior: DEFAULT_LIFETIME_PRIOR
    });
    dashboardAnalytics = overlayLifetimeStatsFromCalculatorTotals(dashboardAnalytics, totals as Record<string, unknown>);
    return {
      overview,
      pnl,
      customers,
      ingredients,
      recipes,
      inventory,
      orders,
      expenses,
      invoices,
      promoCodes,
      kickbackPayments,
      makingPlan,
      dashboardAnalytics,
      calculatorTotals: totals
    };
  }

  /** One pull; dashboard aggregates only (for week/report window changes without re-fetching lists elsewhere). */
  async hubDashboardOnly(params: { weeksBack?: number; reportFrom?: string; reportTo?: string }) {
    this.requireSheetOps();
    const weeksBack = this.parseWeeksBack(params.weeksBack);
    const pull = await this.sheetPullAll();
    const customers = pull.customers || [];
    const ingredients = this.mapSheetIngredientsMerged(pull);
    const recipes = this.mapSheetProductsToRecipes(pull).filter((r: any) => String(r.active ?? "true").toLowerCase() !== "false");
    const inventory = (pull.inventory || []).map((r: any) => ({
      ...r,
      ingredient: String(r.ingredientName || r.productName || r.ingredient || ""),
      quantityLbs: Number(r.quantityOnHand ?? r.quantityLbs ?? 0)
    }));
    const orders = this.normalizeSheetOrdersFromPull(pull);
    const expenses = (pull.expenses || []).map((e: any) => ({
      ...e,
      receiptPath: e.receiptPath || e.receiptUrl || ""
    }));
    const invoices = this.normalizeInvoicesFromPull(pull);
    const totalsRaw = await this.sheetGet<any>("totals").catch(() => null);
    const totals = totalsRaw && totalsRaw.totals ? totalsRaw.totals : {};
    let dashboardAnalytics = computeDashboardAnalytics({
      orders,
      expenses,
      recipes,
      invoices,
      inventory,
      customers,
      ingredients,
      reportFrom: String(params.reportFrom ?? ""),
      reportTo: String(params.reportTo ?? ""),
      weeksBack,
      lifetimePrior: DEFAULT_LIFETIME_PRIOR
    });
    dashboardAnalytics = overlayLifetimeStatsFromCalculatorTotals(dashboardAnalytics, totals as Record<string, unknown>);
    return { dashboardAnalytics, calculatorTotals: totals };
  }

  listCustomers() {
    this.requireSheetOps();
    return this.sheetPullAll().then((x) => x.customers || []);
  }

  createCustomer(data: { name: string; email?: string; phone?: string }) {
    this.requireSheetOps();
    return this.sheetPost("upsertCustomer", data);
  }

  updateCustomer(customerId: string, data: { name: string; email?: string; phone?: string }) {
    this.requireSheetOps();
    return this.sheetPost("upsertCustomer", { id: customerId, ...data });
  }

  listIngredients() {
    this.requireSheetOps();
    return this.sheetPullAll().then((x) => this.mapSheetIngredientsMerged(x));
  }

  async createIngredient(data: {
    name: string;
    category: string;
    unit: string;
    quantityOnHand: number;
    totalCost: number;
    percentAdded: number;
    chargePerPound: number;
  }) {
    this.requireSheetOps();
    const quantity = Number(data.quantityOnHand || 0);
    const cost = Number(data.totalCost || 0);
    const defaultCost = quantity > 0 ? cost / quantity : 0;
    await this.sheetPost("upsertIngredient", {
      name: data.name?.trim(),
      category: data.category?.trim() || "Uncategorized",
      unit: data.unit?.trim() || "lb",
      defaultCost,
      chargePerUnit: Number(data.chargePerPound || 0),
      active: "true"
    });
    await this.sheetPost("addInventory", {
      ingredientName: data.name?.trim(),
      addQuantity: quantity,
      unitCost: defaultCost,
      notes: "Initial ingredient create"
    });
    return { ok: true };
  }

  async purchaseIngredient(data: { ingredientId: string; addedQuantity: number; addedCost: number }) {
    this.requireSheetOps();
    const unitCost = Number(data.addedQuantity || 0) > 0 ? Number(data.addedCost || 0) / Number(data.addedQuantity || 1) : 0;
    return this.sheetPost("addInventory", {
      ingredientId: data.ingredientId,
      addQuantity: Number(data.addedQuantity || 0),
      unitCost,
      notes: "Purchase"
    });
  }

  async adjustIngredientQuantity(data: { ingredientId: string; quantityDelta: number }) {
    this.requireSheetOps();
    return this.sheetPost("addInventory", {
      ingredientId: data.ingredientId,
      addQuantity: Number(data.quantityDelta || 0),
      notes: "Manual adjust"
    });
  }

  async updateIngredientPricing(data: {
    ingredientId: string;
    percentAdded: number;
    chargePerPound: number;
    category?: string;
  }) {
    this.requireSheetOps();
    return this.sheetPost("upsertIngredient", {
      id: data.ingredientId,
      category: data.category,
      chargePerUnit: Number(data.chargePerPound || 0)
    });
  }

  async updateIngredientCore(data: {
    ingredientId: string;
    quantityOnHand: number;
    totalCost: number;
    chargePerPound: number;
    percentAdded?: number;
    category?: string;
  }) {
    this.requireSheetOps();
    const defaultCost = Number(data.quantityOnHand || 0) > 0 ? Number(data.totalCost || 0) / Number(data.quantityOnHand || 1) : 0;
    await this.sheetPost("upsertIngredient", {
      id: data.ingredientId,
      category: data.category,
      defaultCost,
      chargePerUnit: Number(data.chargePerPound || 0)
    });
    return this.sheetPost("upsertInventory", {
      id: `inv_${data.ingredientId}`,
      ingredientId: data.ingredientId,
      quantityOnHand: Number(data.quantityOnHand || 0),
      unitCost: defaultCost,
      receivedAt: new Date().toISOString(),
      notes: "Core update"
    });
  }

  async makeRecipeBatch(data: { recipeId: string; batchLbs: number }) {
    const batchLbs = Number(data.batchLbs || 0);
    if (!Number.isFinite(batchLbs) || batchLbs <= 0) {
      throw new BadRequestException("batchLbs must be greater than 0.");
    }

    this.requireSheetOps();
    const pull = await this.sheetPullAll();
    const products: any[] = pull.products || [];
    const inv: any[] =
      Array.isArray(pull.ingredientInventory) && pull.ingredientInventory.length > 0
        ? pull.ingredientInventory
        : pull.inventory || [];
    const product = products.find((x) => String(x.id) === String(data.recipeId));
    if (!product) throw new BadRequestException("Recipe not found.");
    if (String(product.isBundle ?? "").toLowerCase() === "true") {
      throw new BadRequestException("Bundle recipes cannot be made directly. Make component recipes first.");
    }
    const pairs = this.productIngredientPairsFromSheetRow(product as Record<string, unknown>);
    if (!pairs.length) throw new BadRequestException("Recipe has no ingredient mix.");

    const invByName = new Map<string, { row: any; qty: number }>();
    for (const row of inv) {
      const n = String(row.ingredientName || "").trim().toLowerCase();
      if (!n) continue;
      const q = Number(row.quantityOnHand || 0);
      invByName.set(n, { row, qty: q });
    }

    const neededByName = new Map<string, { name: string; ratioSum: number; neededLbs: number }>();
    for (const pair of pairs) {
      const ratioPct = pair.ratio;
      const need = (ratioPct / 100) * batchLbs;
      const k = pair.name.trim().toLowerCase();
      const cur = neededByName.get(k) || { name: pair.name.trim(), ratioSum: 0, neededLbs: 0 };
      cur.ratioSum += ratioPct;
      cur.neededLbs += need;
      neededByName.set(k, cur);
    }

    const usages = [...neededByName.entries()].map(([key, v]) => {
      const hit = invByName.get(key);
      const onHandLbs = hit?.qty ?? 0;
      return {
        key,
        ingredientName: v.name,
        ratioPct: v.ratioSum,
        neededLbs: v.neededLbs,
        onHandLbs,
        row: hit?.row
      };
    });

    const insufficient = usages.filter((u) => u.neededLbs > u.onHandLbs + 1e-9);
    if (insufficient.length) {
      throw new BadRequestException(
        `Insufficient inventory: ${insufficient
          .map((u) => `${u.ingredientName} needs ${u.neededLbs.toFixed(2)} lb, has ${u.onHandLbs.toFixed(2)} lb`)
          .join("; ")}`
      );
    }

    for (const u of usages) {
      const ingredientId = u.row?.ingredientId ? String(u.row.ingredientId) : "";
      await this.sheetPost("addInventory", {
        ingredientId,
        ingredientName: u.ingredientName,
        addQuantity: -Number(u.neededLbs.toFixed(4)),
        unitCost: Number(u.row?.unitCost || 0),
        notes: `Make batch ${data.recipeId} (${batchLbs} lb)`
      });
    }

    return {
      recipeId: String(product.id),
      recipeName: String(product.name || ""),
      batchLbs,
      usages: usages.map((u) => ({
        ingredientId: u.row?.ingredientId ? String(u.row.ingredientId) : "",
        ingredientName: u.ingredientName,
        ratioPct: u.ratioPct,
        usedLbs: Number(u.neededLbs.toFixed(4))
      }))
    };
  }

  listRecipes() {
    this.requireSheetOps();
    return this.sheetPullAll().then((x) =>
      this.mapSheetProductsToRecipes(x).filter((r: any) => String(r.active ?? "true").toLowerCase() !== "false")
    );
  }

  createExpense(data: {
    vendor: string;
    category: string;
    amount: number;
    expenseDate: string;
    receiptPath?: string;
    notes?: string;
    paymentMethod?: string;
  }) {
    this.requireSheetOps();
    const rp = String(data.receiptPath || "").trim();
    if (rp.startsWith("data:")) {
      throw new BadRequestException(
        "Receipt image is too large to store in the sheet. Use “Choose file” so the photo is saved on the hub and only a link is written to Google Sheets."
      );
    }
    const paymentMethod = String(data.paymentMethod || "").trim();
    return this.sheetPost("upsertExpense", {
      vendor: data.vendor,
      category: this.normalizeExpenseCategory(data.category, `${data.vendor} ${data.notes || ""}`),
      amount: Number(data.amount || 0),
      expenseDate: data.expenseDate,
      receiptUrl: rp,
      notes: data.notes || "",
      paymentMethod
    });
  }

  listExpenses() {
    this.requireSheetOps();
    return this.sheetPullAll().then((x) =>
      (x.expenses || []).map((e: any) => ({
        ...e,
        receiptPath: e.receiptPath || e.receiptUrl || ""
      }))
    );
  }

  recategorizeExpense(data: { expenseId: string; category: string }) {
    this.requireSheetOps();
    return (async () => {
      const all = await this.sheetPullAll();
      const e = (all.expenses || []).find((r: any) => String(r.id) === String(data.expenseId));
      if (!e) throw new BadRequestException("Expense not found");
      const cat = this.normalizeExpenseCategory(data.category, `${e.vendor} ${e.notes || ""}`);
      return this.sheetPost("upsertExpense", {
        ...e,
        id: e.id,
        category: cat,
        receiptUrl: String(e.receiptUrl || e.receiptPath || "")
      });
    })();
  }

  updateExpense(
    expenseId: string,
    data: {
      vendor: string;
      category: string;
      amount: number;
      expenseDate: string;
      receiptPath?: string;
      notes?: string;
      paymentMethod?: string;
    }
  ) {
    this.requireSheetOps();
    const rp = String(data.receiptPath || "").trim();
    if (rp.startsWith("data:")) {
      throw new BadRequestException(
        "Do not paste base64 receipts into the sheet. Upload the file on the hub so only a link is stored."
      );
    }
    const paymentMethod = String(data.paymentMethod ?? "").trim();
    return this.sheetPost("upsertExpense", {
      id: expenseId,
      vendor: data.vendor,
      category: data.category,
      amount: data.amount,
      expenseDate: data.expenseDate,
      notes: data.notes ?? "",
      receiptUrl: rp,
      paymentMethod
    });
  }

  async bulkImportExpenses(
    rows: Array<{ expenseDate: string; vendor: string; description?: string; category: string; amount: number; payment?: string; receipt?: string }>
  ) {
    this.requireSheetOps();
    let created = 0;
    for (const row of rows) {
      const date = row.expenseDate?.trim();
      const vendor = row.vendor?.trim();
      if (!date || !vendor || !Number.isFinite(row.amount)) continue;
      const notes = [row.description?.trim(), row.payment?.trim()].filter(Boolean).join(" | ");
      const category = this.normalizeExpenseCategory(row.category, `${vendor} ${row.description || ""} ${row.payment || ""}`);
      await this.sheetPost("upsertExpense", {
        expenseDate: date,
        vendor,
        category,
        amount: Number(row.amount),
        notes: notes || "",
        receiptUrl: row.receipt?.trim() || ""
      });
      created += 1;
    }
    return { created };
  }

  async normalizeAllExpenseCategories() {
    this.requireSheetOps();
    const rows = (await this.sheetPullAll().then((x) => x.expenses || [])) as any[];
    let updated = 0;
    for (const row of rows) {
      const next = this.normalizeExpenseCategory(row.category, `${row.vendor} ${row.notes || ""}`);
      if (next !== row.category) {
        await this.sheetPost("upsertExpense", {
          ...row,
          category: next,
          receiptUrl: String(row.receiptUrl || row.receiptPath || "")
        });
        updated += 1;
      }
    }
    return { updated, total: rows.length };
  }

  createRecipe(data: {
    name: string;
    description?: string;
    foodType?: string;
    costPerPound: number;
    salePrice: number;
    chargeUnit?: string;
    amountPerUnit?: number;
  }) {
    this.requireSheetOps();
    return this.sheetPost("upsertProduct", {
      name: data.name,
      description: data.description,
      foodType: data.foodType || "Adult",
      chargeUnit: data.chargeUnit || "lb",
      amountPerUnit: Number(data.amountPerUnit || 1),
      price: Number(data.salePrice || 0),
      costPerLb: Number(data.costPerPound || 0),
      isBundle: "false",
      active: "true"
    });
  }

  async createRecipeWithIngredients(data: {
    name: string;
    description?: string;
    foodType?: string;
    costPerPound: number;
    salePrice: number;
    chargeUnit?: string;
    amountPerUnit?: number;
    isBundle?: boolean;
    ingredients: Array<{ ingredientId: string; quantity: number }>;
    bundleItems?: Array<{ ingredientId: string; quantity: number }>;
  }) {
    this.requireSheetOps();
    const allIngredients = await this.sheetPullAll().then((x) => x.ingredients || []);
    const byId: Record<string, any> = {};
    for (const ing of allIngredients) byId[String(ing.id)] = ing;
    const lines = (data.ingredients || [])
      .map((ln) => {
        const id = String(ln.ingredientId || "").trim();
        let ingredientName = String(byId[id]?.name || "").trim();
        if (!ingredientName && id) ingredientName = id;
        return { ingredientName, ratioPercent: Number(ln.quantity || 0) };
      })
      .filter((x) => x.ingredientName && x.ratioPercent > 0);
    if (!Boolean(data.isBundle) && lines.length === 0) {
      throw new BadRequestException("Recipe must include at least one ingredient with quantity greater than 0.");
    }
    return this.sheetPost("upsertProduct", {
      name: data.name,
      description: data.description,
      foodType: data.foodType || "Adult",
      chargeUnit: data.chargeUnit || "lb",
      amountPerUnit: Number(data.amountPerUnit || 1),
      price: Number(data.salePrice || 0),
      costPerLb: Number(data.costPerPound || 0),
      isBundle: String(Boolean(data.isBundle)),
      ingredients: lines,
      active: "true"
    });
  }

  async updateRecipeWithIngredients(
    recipeId: string,
    data: {
      name: string;
      description?: string;
      foodType?: string;
      costPerPound: number;
      salePrice: number;
      chargeUnit?: string;
      amountPerUnit?: number;
      isBundle?: boolean;
      ingredients: Array<{ ingredientId: string; quantity: number }>;
      bundleItems?: Array<{ ingredientId: string; quantity: number }>;
    }
  ) {
    this.requireSheetOps();
    const allIngredients = await this.sheetPullAll().then((x) => x.ingredients || []);
    const byId: Record<string, any> = {};
    for (const ing of allIngredients) byId[String(ing.id)] = ing;
    const lines = (data.ingredients || [])
      .map((ln) => {
        const id = String(ln.ingredientId || "").trim();
        let ingredientName = String(byId[id]?.name || "").trim();
        if (!ingredientName && id) ingredientName = id;
        return { ingredientName, ratioPercent: Number(ln.quantity || 0) };
      })
      .filter((x) => x.ingredientName && x.ratioPercent > 0);
    return this.sheetPost("upsertProduct", {
      id: recipeId,
      name: data.name,
      description: data.description,
      foodType: data.foodType || "Adult",
      chargeUnit: data.chargeUnit || "lb",
      amountPerUnit: Number(data.amountPerUnit || 1),
      price: Number(data.salePrice || 0),
      costPerLb: Number(data.costPerPound || 0),
      isBundle: String(Boolean(data.isBundle)),
      ingredients: lines,
      active: "true"
    });
  }

  deleteRecipe(recipeId: string) {
    this.requireSheetOps();
    return this.sheetPost("upsertProduct", { id: recipeId, active: "false" });
  }

  async addRecipeIngredient(data: { recipeId: string; ingredientId: string; quantity: number }) {
    this.requireSheetOps();
    const pull = await this.sheetPullAll();
    const products: any[] = pull.products || [];
    const product = products.find((p: any) => String(p.id) === String(data.recipeId));
    if (!product) throw new BadRequestException("Recipe not found.");
    const allIngredients = pull.ingredients || [];
    const byId: Record<string, any> = {};
    for (const ing of allIngredients) byId[String(ing.id)] = ing;
    const addName = String(byId[String(data.ingredientId)]?.name || "").trim();
    if (!addName) throw new BadRequestException("Ingredient not found.");
    const existing = this.productIngredientPairsFromSheetRow(product as Record<string, unknown>);
    const merged = new Map<string, { name: string; ratio: number }>();
    for (const e of existing) merged.set(e.name.trim().toLowerCase(), { name: e.name.trim(), ratio: e.ratio });
    const k = addName.toLowerCase();
    const prev = merged.get(k);
    const addQty = Number(data.quantity || 0);
    if (!(addQty > 0)) throw new BadRequestException("Quantity must be greater than 0.");
    merged.set(k, { name: addName, ratio: (prev?.ratio || 0) + addQty });
    const lines = [...merged.values()]
      .filter((x) => x.ratio > 0)
      .map((x) => ({ ingredientName: x.name, ratioPercent: x.ratio }));
    return this.sheetPost("upsertProduct", {
      id: data.recipeId,
      name: String(product.name || ""),
      description: product.description,
      foodType: product.foodType || "Adult",
      chargeUnit: product.chargeUnit || "lb",
      amountPerUnit: Number(product.amountPerUnit || 1),
      price: Number(product.price || 0),
      costPerLb: Number(product.costPerLb || product.cost || 0),
      isBundle: String(product.isBundle ?? "false"),
      ingredients: lines,
      active: String(product.active ?? "true")
    });
  }

  listInventory() {
    this.requireSheetOps();
    return this.sheetPullAll().then((x) =>
      (x.inventory || []).map((r: any) => ({
        ...r,
        ingredient: String(r.ingredientName || r.ingredient || ""),
        quantityLbs: Number(r.quantityOnHand ?? r.quantityLbs ?? 0)
      }))
    );
  }

  createInventoryLot(data: { ingredient: string; quantityLbs: number; unitCost: number; receivedAt: string }) {
    this.requireSheetOps();
    return this.sheetPost("addInventory", {
      ingredientName: data.ingredient,
      addQuantity: Number(data.quantityLbs || 0),
      unitCost: Number(data.unitCost || 0),
      receivedAt: data.receivedAt,
      notes: "Inventory tab add"
    });
  }

  listOrders() {
    this.requireSheetOps();
    return this.sheetPullAll().then((x) => this.normalizeSheetOrdersFromPull(x));
  }

  /**
   * Final consumer site → same contract as Apps Script `submitOrder`.
   * Writes Pending through the existing controller (GOOGLE_SHEET_APPS_SCRIPT_URL).
   */
  finalSiteExpressSubmitOrder(dto: {
    customerName: string;
    phone?: string;
    email?: string;
    address?: string;
    items: Array<{
      productId?: string;
      productName?: string;
      quantity: number;
      quantityUnit?: string;
      unitPrice?: number;
    }>;
    notes?: string;
    promoCode?: string;
    id?: string;
    createdAt?: string;
  }) {
    this.requireSheetOps();
    const items = (dto.items || []).map((x) => ({
      productId: x.productId,
      productName: x.productName,
      quantity: Number(x.quantity),
      quantityUnit: x.quantityUnit || "lb",
      unitPrice: x.unitPrice != null && Number.isFinite(Number(x.unitPrice)) ? Number(x.unitPrice) : undefined
    }));
    return this.sheetPost("submitOrder", {
      customerName: String(dto.customerName || "").trim(),
      phone: String(dto.phone || ""),
      email: String(dto.email || ""),
      address: String(dto.address || ""),
      items,
      notes: String(dto.notes || ""),
      promoCode: String(dto.promoCode || ""),
      ...(dto.id ? { id: String(dto.id) } : {}),
      ...(dto.createdAt ? { createdAt: String(dto.createdAt) } : {})
    });
  }

  async createOrder(data: {
    customerId: string;
    quantityLbs?: number;
    paymentMethod?: string;
    subtotal: number;
    cogs?: number;
    margin?: number;
    status?: OrderStatus;
    notes?: string;
    recipeId?: string;
    promoCode?: string;
    items?: Array<{ recipeId: string; quantityLbs: number }>;
  }) {
    this.requireSheetOps();
    const customers = await this.sheetPullAll().then((x) => x.customers || []);
    const customer = customers.find((c: any) => String(c.id || "") === String(data.customerId || ""));
    if (!customer) throw new BadRequestException("Customer not found");
    const items = Array.isArray(data.items)
      ? data.items.map((x) => ({ productId: x.recipeId, quantity: Number(x.quantityLbs || 0), quantityUnit: "lb" }))
      : [];
    if (items.length > 0) {
      return this.sheetPost("submitOrder", {
        customerName: customer.name || "",
        phone: customer.phone || "",
        email: customer.email || "",
        address: customer.address || "",
        items,
        notes: data.notes || "",
        promoCode: data.promoCode?.trim() || ""
      });
    }
    return this.sheetPost("upsertPending", {
      customerName: customer.name || "",
      phone: customer.phone || "",
      email: customer.email || "",
      address: customer.address || "",
      recipe: "",
      quantityLbs: Number(data.quantityLbs || 0),
      subtotalTaxIncl: Number(data.subtotal || 0),
      notes: data.notes || "",
      promoCode: data.promoCode?.trim() || ""
    });
  }

  updateOrderStatus(data: { orderId: string; status: OrderStatus }) {
    this.requireSheetOps();
    return (async () => {
      const all = await this.sheetPullAll();
      const p = (all.pending || []).find((x: any) => String(x.id) === String(data.orderId));
      if (p) {
        return this.sheetPost("upsertPending", {
          ...p,
          id: data.orderId,
          status: data.status
        });
      }
      const a = (all.archive || []).find((x: any) => String(x.id) === String(data.orderId));
      if (a) {
        return this.sheetPost("upsertArchive", {
          ...a,
          id: data.orderId,
          status: data.status
        });
      }
      throw new BadRequestException("Order not found");
    })();
  }

  async updateOrder(orderId: string, data: {
    quantityLbs?: number;
    subtotal?: number;
    cogs?: number;
    margin?: number;
    notes?: string;
    paymentMethod?: string;
  }) {
    this.requireSheetOps();
    const all = await this.sheetPullAll();
    const p = (all.pending || []).find((x: any) => String(x.id) === String(orderId));
    if (p) return this.sheetPost("upsertPending", { ...p, ...data, id: orderId });
    const a = (all.archive || []).find((x: any) => String(x.id) === String(orderId));
    if (a) return this.sheetPost("upsertArchive", { ...a, ...data, id: orderId });
    throw new BadRequestException("Order not found");
  }

  async updateOrderItems(orderId: string, data: { items: Array<{ recipeId: string; quantityLbs: number }>; notes?: string }) {
    this.requireSheetOps();
    const all = await this.sheetPullAll();
    const p = (all.pending || []).find((x: any) => String(x.id) === String(orderId));
    if (!p) throw new BadRequestException("Pending order not found");
    const products = all.products || [];
    const byId: Record<string, any> = {};
    for (const pr of products) byId[String(pr.id)] = pr;
    const items = (data.items || []).map((x) => ({
      productId: x.recipeId,
      productName: String(byId[String(x.recipeId)]?.name || ""),
      quantity: Number(x.quantityLbs || 0),
      quantityUnit: "lb",
      unitPrice: Number(byId[String(x.recipeId)]?.price || 0)
    }));
    const subtotal = items.reduce((s, it) => s + Number(it.quantity || 0) * Number(it.unitPrice || 0), 0);
    const qty = items.reduce((s, it) => s + Number(it.quantity || 0), 0);
    return this.sheetPost("upsertPending", {
      ...p,
      id: orderId,
      orderItemsJson: JSON.stringify(items),
      quantityLbs: qty,
      subtotalTaxIncl: subtotal,
      notes: data.notes ?? p.notes ?? ""
    });
  }

  async deleteOrderCascade(orderId: string) {
    this.requireSheetOps();
    const all = await this.sheetPullAll();
    const p = (all.pending || []).find((x: any) => String(x.id) === String(orderId));
    if (p) return this.sheetPost("deleteOrder", { id: orderId, bucket: "pending" });
    const a = (all.archive || []).find((x: any) => String(x.id) === String(orderId));
    if (a) return this.sheetPost("deleteOrder", { id: orderId, bucket: "archive" });
    return { deleted: true };
  }

  updateOrderProgress(data: { orderId: string; paid?: boolean; paymentMethod?: string; pickedUp?: boolean }) {
    this.requireSheetOps();
    return (async () => {
      const all = await this.sheetPullAll();
      const p = (all.pending || []).find((x: any) => String(x.id) === String(data.orderId));
      if (!p) throw new BadRequestException("Pending order not found");
      if (data.paid) {
        await this.sheetPost("recordPayment", {
          orderId: data.orderId,
          invoiceNumber: p.invoiceNumber || "",
          amount: Number(p.subtotalTaxIncl || 0),
          paymentMethod: data.paymentMethod || "Unknown",
          status: "PAID"
        });
      }
      if (data.pickedUp) {
        return this.sheetPost("movePendingToArchive", {
          id: data.orderId,
          status: data.paid ? "FULFILLED" : "CONFIRMED",
          notes: p.notes || ""
        });
      }
      return this.sheetPost("upsertPending", {
        ...p,
        id: data.orderId,
        status: data.paid ? "PAID" : p.status,
        notes: p.notes || ""
      });
    })();
  }

  async applyOrderPartialPayment(data: { orderId: string; amount: number; paymentMethod: string }) {
    this.requireSheetOps();
    const all = await this.sheetPullAll();
    const p = (all.pending || []).find((x: any) => String(x.id) === String(data.orderId));
    if (!p) throw new BadRequestException("Pending order not found");
    await this.sheetPost("recordPayment", {
      orderId: data.orderId,
      invoiceNumber: p.invoiceNumber || "",
      amount: Number(data.amount || 0),
      paymentMethod: data.paymentMethod,
      status: "PARTIAL"
    });
    return { ok: true };
  }

  async createInvoice(data: { orderId: string; invoiceNumber: string; amount: number }) {
    this.requireSheetOps();
    return this.sheetPost("recordPayment", {
      orderId: data.orderId,
      invoiceNumber: data.invoiceNumber,
      amount: Number(data.amount || 0),
      paymentMethod: "Unpaid",
      status: "UNPAID"
    });
  }

  listInvoices() {
    this.requireSheetOps();
    return this.sheetPullAll().then((x) => {
      const payments = x.payments || [];
      const pending = x.pending || [];
      const archive = x.archive || [];
      const byId = new Map<string, any>();
      for (const o of [...pending, ...archive]) byId.set(String(o.id || ""), o);
      return payments.map((p: any) => {
        const o = byId.get(String(p.orderId || ""));
        return {
          id: p.id,
          invoiceNumber: p.invoiceNumber || "",
          amount: Number(p.amount || 0),
          orderId: p.orderId || "",
          createdAt: p.createdAt || p.updatedAt || new Date().toISOString(),
          payment: {
            status: p.status || "UNPAID",
            amount: Number(p.amount || 0),
            paidAt: p.paidAt || null
          },
          order: o
            ? {
                id: o.id,
                customer: {
                  name: o.customerName,
                  email: o.email,
                  phone: o.phone
                }
              }
            : null
        };
      });
    });
  }

  markInvoicePaid(data: { invoiceId: string; amount: number; status?: string }) {
    this.requireSheetOps();
    return this.sheetPost("upsertPayment", {
      id: data.invoiceId,
      amount: Number(data.amount || 0),
      status: data.status || "PAID",
      paidAt: new Date().toISOString()
    });
  }

  /** Legacy endpoints: invoice PDFs and numbering are handled in Sheet / Apps Script + Drive. */
  syncPendingOrderInvoices() {
    this.requireSheetOps();
    return { ok: true, synced: 0, message: "No server-side invoice PDF pipeline; use the Google Sheet/Drive workflow." };
  }

  syncArchiveOrderInvoices() {
    this.requireSheetOps();
    return { ok: true, synced: 0, message: "No server-side invoice PDF pipeline; use the Google Sheet/Drive workflow." };
  }

  regenerateAllInvoicePdfs() {
    this.requireSheetOps();
    return { ok: true, regenerated: 0, message: "Invoice PDFs are not generated by this API." };
  }

  syncPendingArchiveAndRegenerateAllInvoices() {
    this.requireSheetOps();
    return {
      ok: true,
      message: "Invoice PDFs are not generated by this API.",
      pending: { ok: true, synced: 0 },
      archive: { ok: true, synced: 0 },
      regenerate: { ok: true, regenerated: 0 }
    };
  }

  ensureInvoiceForPendingOrder(orderId: string) {
    this.requireSheetOps();
    return { ok: true, orderId, message: "Create or update invoices from the Google Sheet; this API does not write PDFs." };
  }

  listPromoCodes() {
    this.requireSheetOps();
    return this.sheetReadPromoCodes().then((rows) =>
      [...rows].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    );
  }

  async createPromoCode(data: {
    code: string;
    label?: string;
    kind: PromoKind;
    active?: boolean;
    discountPercent?: number | null;
    discountFixed?: number | null;
    kickbackPercent?: number | null;
    kickbackFixed?: number | null;
    payeeNotes?: string | null;
  }) {
    const code = String(data.code || "").trim().toUpperCase();
    if (!code) throw new BadRequestException("Code is required.");
    const label = String(data.label || "").trim() || code;
    this.requireSheetOps();
    const existing = await this.sheetReadPromoCodes();
    if (existing.some((r) => String(r.code || "").trim().toUpperCase() === code)) {
      throw new BadRequestException("Promo code already exists.");
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const row = {
      id,
      code,
      label,
      kind: data.kind,
      active: data.active ?? true,
      discountPercent: data.discountPercent != null ? Number(data.discountPercent) : null,
      discountFixed: data.discountFixed != null ? Number(data.discountFixed) : null,
      kickbackPercent: data.kickbackPercent != null ? Number(data.kickbackPercent) : null,
      kickbackFixed: data.kickbackFixed != null ? Number(data.kickbackFixed) : null,
      payeeNotes: data.payeeNotes?.trim() || null,
      createdAt
    };
    existing.push(row);
    await this.sheetWritePromoCodes(existing);
    return row;
  }

  async updatePromoCode(
    id: string,
    data: Partial<{
      label: string;
      active: boolean;
      discountPercent: number | null;
      discountFixed: number | null;
      kickbackPercent: number | null;
      kickbackFixed: number | null;
      payeeNotes: string | null;
    }>
  ) {
    if (data.label !== undefined) {
      const l = String(data.label || "").trim();
      if (!l) throw new BadRequestException("Label cannot be empty.");
    }
    this.requireSheetOps();
    const rows = await this.sheetReadPromoCodes();
    const idx = rows.findIndex((r) => String(r.id) === String(id));
    if (idx < 0) throw new BadRequestException("Promo code not found.");
    const cur = rows[idx];
    const next = {
      ...cur,
      ...(data.label !== undefined ? { label: String(data.label).trim() } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.discountPercent !== undefined ? { discountPercent: data.discountPercent } : {}),
      ...(data.discountFixed !== undefined ? { discountFixed: data.discountFixed } : {}),
      ...(data.kickbackPercent !== undefined ? { kickbackPercent: data.kickbackPercent } : {}),
      ...(data.kickbackFixed !== undefined ? { kickbackFixed: data.kickbackFixed } : {}),
      ...(data.payeeNotes !== undefined ? { payeeNotes: data.payeeNotes?.trim() || null } : {})
    };
    rows[idx] = next;
    await this.sheetWritePromoCodes(rows);
    return next;
  }

  async getCoopKickbackSummary() {
    this.requireSheetOps();
    const promos = await this.sheetReadPromoCodes();
    const coopByCode = new Map<string, any>();
    for (const p of promos) {
      if (p.active === false) continue;
      const k = String(p.code || "").trim().toUpperCase();
      if (k) coopByCode.set(k, p);
    }
    const data = await this.sheetPullAll();
    type Acc = {
      promoCodeId: string;
      code: string;
      label: string;
      payeeNotes: string | null;
      orderCount: number;
      kickbackOwed: number;
      revenueTaxIncl: number;
    };
    const map = new Map<string, Acc>();
    const ingest = (r: any) => {
      const code = String(r.promoCodeEntered || r.promoCode || "").trim().toUpperCase();
      if (!code) return;
      const promo = coopByCode.get(code);
      if (!promo) return;
      const pid = String(promo.id);
      const cur =
        map.get(pid) ??
        ({
          promoCodeId: pid,
          code: String(promo.code || ""),
          label: String(promo.label || ""),
          payeeNotes: promo.payeeNotes ?? null,
          orderCount: 0,
          kickbackOwed: 0,
          revenueTaxIncl: 0
        } as Acc);
      cur.orderCount += 1;
      cur.kickbackOwed += Number(r.coOpKickbackOwed ?? r.coopKickbackOwed ?? 0);
      cur.revenueTaxIncl += Number(r.subtotalTaxIncl ?? r.subtotal ?? 0);
      map.set(pid, cur);
    };
    for (const r of data.pending || []) ingest(r);
    for (const r of data.archive || []) ingest(r);
    const payments = this.readKickbackPaymentsFromPullData(data);
    const paidByCode = new Map<string, number>();
    const lastPaidByCode = new Map<string, string>();
    for (const p of payments) {
      const c = String(p.promoCode || "").trim().toUpperCase();
      if (!c) continue;
      paidByCode.set(c, (paidByCode.get(c) || 0) + Number(p.amountPaid || 0));
      const ts = String(p.paidAt || p.createdAt || "").trim();
      if (ts) {
        const prev = lastPaidByCode.get(c);
        if (!prev || ts.localeCompare(prev) > 0) lastPaidByCode.set(c, ts);
      }
    }
    return [...map.values()]
      .map((row) => {
        const codeU = String(row.code || "").trim().toUpperCase();
        const paid = paidByCode.get(codeU) || 0;
        const owed = row.kickbackOwed;
        return {
          ...row,
          kickbackPaid: paid,
          kickbackOutstanding: owed - paid,
          lastKickbackPaidAt: lastPaidByCode.get(codeU) ?? null
        };
      })
      .sort((a, b) => b.kickbackOwed - a.kickbackOwed);
  }

  listKickbackPayments() {
    this.requireSheetOps();
    return this.sheetPullAll().then((pull) =>
      [...this.readKickbackPaymentsFromPullData(pull)].sort((a, b) =>
        String(b.paidAt || b.createdAt || "").localeCompare(String(a.paidAt || a.createdAt || ""))
      )
    );
  }

  async recordKickbackPayment(body: {
    paidAt?: string;
    periodFrom: string;
    periodTo: string;
    promoCode?: string;
    promoLabel?: string;
    amountPaid: number;
    notes?: string;
  }) {
    this.requireSheetOps();
    const periodFrom = String(body.periodFrom || "").trim();
    const periodTo = String(body.periodTo || "").trim();
    if (!periodFrom || !periodTo) throw new BadRequestException("Settlement period (from / to) is required.");
    const amountPaid = Number(body.amountPaid);
    if (!(amountPaid > 0)) throw new BadRequestException("amountPaid must be greater than 0.");
    const promoCode = String(body.promoCode || "").trim();
    const promoLabel = String(body.promoLabel || "").trim();
    const notes = String(body.notes || "").trim();
    const paidAt = String(body.paidAt || "").trim();
    return this.sheetPost<{ ok: boolean; row: Record<string, unknown> }>("appendKickbackPayment", {
      paidAt: paidAt || undefined,
      periodFrom,
      periodTo,
      promoCode: promoCode || undefined,
      promoLabel: promoLabel || undefined,
      amountPaid,
      notes: notes || undefined
    }).then((r) => r.row);
  }

  /**
   * Reads `.ics` files from WORKERS_CALENDAR_PATH (or ~/Desktop/JR Workers ACCES) for the in-app Calendar “Workers” feed.
   * Recurring events are expanded ~1y back / ~2y forward.
   */
  async getWorkersIcsCalendar(): Promise<{
    events: WorkersIcsEventDto[];
    pathTried: string;
    fileCount: number;
    warning?: string;
  }> {
    const pathTried = this.resolveWorkersCalendarPath(this.config.get<string>("WORKERS_CALENDAR_PATH"));
    const { files, warning: pathWarning } = this.listIcsFiles(pathTried);
    const parseWarnings: string[] = [];
    if (pathWarning) parseWarnings.push(pathWarning);

    const expandFrom = new Date();
    expandFrom.setFullYear(expandFrom.getFullYear() - 1);
    expandFrom.setHours(0, 0, 0, 0);
    const expandTo = new Date();
    expandTo.setFullYear(expandTo.getFullYear() + 2);
    expandTo.setHours(23, 59, 59, 999);

    const rows: WorkersIcsEventDto[] = [];
    const seenIds = new Set<string>();

    for (const filePath of files) {
      let parsed: nodeIcal.CalendarResponse;
      try {
        const body = await readFile(filePath, "utf8");
        parsed = await nodeIcal.async.parseICS(body);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        parseWarnings.push(`Failed to read/parse ${basename(filePath)}: ${msg}`);
        continue;
      }
      const sourceFile = basename(filePath);
      for (const item of Object.values(parsed)) {
        if (!item || typeof item !== "object") continue;
        const t = (item as { type?: string }).type;
        if (t !== "VEVENT") continue;
        const ev = item as VEvent;
        if (ev.status === "CANCELLED") continue;

        const title = this.icalParamToString(ev.summary).trim() || "(No title)";
        const description = this.icalParamToString(ev.description).trim();
        const location = this.icalParamToString(ev.location).trim();
        const uid = String(ev.uid || title || randomUUID());

        const pushRow = (start: Date, end: Date | null, allDay: boolean) => {
          const row = this.buildWorkersIcsRow(uid, start, end, allDay, title, description, location, sourceFile);
          if (seenIds.has(row.id)) return;
          seenIds.add(row.id);
          rows.push(row);
        };

        try {
          if (ev.rrule) {
            const instances = nodeIcal.expandRecurringEvent(ev, { from: expandFrom, to: expandTo });
            for (const inst of instances) {
              const s = this.eventDateToJs(inst.start);
              const en = inst.end ? this.eventDateToJs(inst.end) : null;
              if (!s) continue;
              pushRow(s, en, inst.isFullDay);
            }
          } else {
            const s = this.eventDateToJs(ev.start);
            const en = ev.end ? this.eventDateToJs(ev.end) : null;
            if (!s) continue;
            const allDay = ev.datetype === "date";
            pushRow(s, en, allDay);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          parseWarnings.push(`${sourceFile} (“${title}”): ${msg}`);
        }
      }
    }

    rows.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));

    return {
      events: rows,
      pathTried,
      fileCount: files.length,
      warning: parseWarnings.length ? parseWarnings.slice(0, 10).join(" · ") : undefined
    };
  }

  private resolveWorkersCalendarPath(configPath: string | undefined): string {
    const trimmed = configPath?.trim();
    if (trimmed) return resolve(trimmed);
    return resolve(join(homedir(), "Desktop", "JR Workers ACCES"));
  }

  private listIcsFiles(absPath: string): { files: string[]; warning?: string } {
    if (!existsSync(absPath)) {
      return { files: [], warning: `Path does not exist: ${absPath}` };
    }
    const st = statSync(absPath);
    if (st.isFile()) {
      if (extname(absPath).toLowerCase() === ".ics") return { files: [absPath] };
      return { files: [], warning: `Not an .ics file: ${absPath}` };
    }
    if (!st.isDirectory()) {
      return { files: [], warning: `Not a file or directory: ${absPath}` };
    }
    const names = readdirSync(absPath);
    const files = names.filter((n) => extname(n).toLowerCase() === ".ics").map((n) => join(absPath, n));
    if (files.length === 0) {
      return { files: [], warning: `No .ics files in: ${absPath}` };
    }
    return { files };
  }

  private icalParamToString(val: unknown): string {
    if (val == null) return "";
    if (typeof val === "string") return val;
    if (typeof val === "object" && val !== null && "val" in val) {
      const inner = (val as { val?: unknown }).val;
      return inner != null ? String(inner) : "";
    }
    return String(val);
  }

  private eventDateToJs(d: unknown): Date | null {
    if (!d) return null;
    if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d;
    try {
      const t = new Date(d as string);
      return Number.isNaN(t.getTime()) ? null : t;
    } catch {
      return null;
    }
  }

  private buildWorkersIcsRow(
    uid: string,
    start: Date,
    end: Date | null,
    allDay: boolean,
    title: string,
    description: string,
    location: string,
    sourceFile: string
  ): WorkersIcsEventDto {
    const y = start.getFullYear();
    const mo = String(start.getMonth() + 1).padStart(2, "0");
    const da = String(start.getDate()).padStart(2, "0");
    const date = `${y}-${mo}-${da}`;
    let time = "";
    if (!allDay) {
      time = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
    }
    const id = `${uid}|${start.toISOString()}|${sourceFile}`;
    return {
      id,
      uid,
      title,
      date,
      time,
      allDay,
      start: start.toISOString(),
      end: end && !Number.isNaN(end.getTime()) ? end.toISOString() : "",
      description,
      location,
      sourceFile
    };
  }
}
