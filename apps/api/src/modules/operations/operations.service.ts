import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OrderStatus, PromoKind } from "@prisma/client";
import { randomUUID } from "crypto";
import { existsSync, readdirSync, statSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { basename, extname, join, resolve } from "path";
import { once } from "events";
import { PassThrough } from "stream";
import * as nodeIcal from "node-ical";
import type { VEvent } from "node-ical";
/** PDFKit is CJS; default import compiles to `.default` and breaks at runtime. */
import PDFKit = require("pdfkit");
import { PrismaService } from "../prisma/prisma.service";
import { getExpensesUploadDir, getInvoicesArchiveDir, getInvoicesDir, resolveInvoiceLogoPathFromInvoicesDir } from "../../paths";
import { StorageService } from "../../storage/storage.service";

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

  private normalizeRecipeLines(lines: Array<{ ingredientId: string; quantity: number }> | undefined) {
    const byIngredient = new Map<string, number>();
    for (const line of lines || []) {
      const ingredientId = String(line?.ingredientId || "").trim();
      const quantity = this.normalizeRecipeRatioPercent(line?.quantity || 0);
      if (!ingredientId || !Number.isFinite(quantity) || quantity <= 0) continue;
      byIngredient.set(ingredientId, (byIngredient.get(ingredientId) || 0) + quantity);
    }
    return [...byIngredient.entries()].map(([ingredientId, quantity]) => ({ ingredientId, quantity }));
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService
  ) {}

  /** Demo PDF + optional one-time full invoice pass (see `Invoices/README.md`). */
  async onModuleInit() {
    try {
      const { url } = await this.ensureDemoInvoiceSample();
      this.logger.log(`Demo invoice ready at ${url}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Demo invoice not written: ${msg}`);
    }

    const stampName = ".jr-pending-archive-full-sync.done";
    const stampPath = join(
      this.storage.usesObjectStorage() ? this.storage.getBootstrapCacheDir() : this.invoicesUploadDir(),
      stampName
    );
    const force =
      this.config.get<string>("INVOICE_FORCE_FULL_SYNC_ON_START") === "1" ||
      this.config.get<string>("INVOICE_FORCE_FULL_SYNC_ON_START")?.toLowerCase() === "true";
    const shouldRun = force || !existsSync(stampPath);
    if (!shouldRun) return;

    try {
      this.logger.log(
        force
          ? "INVOICE_FORCE_FULL_SYNC_ON_START: running full pending+archive sync + PDF regenerate…"
          : "First-time invoice bootstrap: syncing pending + archive and regenerating all PDFs (stamp file will be written)…"
      );
      const r = await this.syncPendingArchiveAndRegenerateAllInvoices();
      this.logger.log(
        `Invoice bootstrap done — pending: +${r.pendingSync.created} new, ${r.pendingSync.pdfRepaired} PDF repaired, ${r.pendingSync.skipped} skipped, ${r.pendingSync.failed} failed | archive: +${r.archiveSync.created} new, ${r.archiveSync.pdfRepaired} repaired, ${r.archiveSync.skipped} skipped, ${r.archiveSync.failed} failed | regenerate: ${r.regenerate.updated}/${r.regenerate.total} PDFs, ${r.regenerate.failed} failed`
      );
      if (r.regenerate.logoUsed) this.logger.log(`Invoice logo: ${r.regenerate.logoUsed}`);
      if (!force) {
        writeFileSync(stampPath, `completedAt=${new Date().toISOString()}\n`, "utf8");
        this.logger.log(`Stamp written (delete ${stampName} in Invoices/ to run this again).`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Invoice bootstrap failed: ${msg}`);
    }
  }

  /**
   * Same renderer as real orders; writes `DEMO-sample-invoice.pdf` (+ archive copy).
   * Safe to call on startup — does not touch the database.
   */
  async ensureDemoInvoiceSample(): Promise<{ url: string; path: string }> {
    const demoPreTax = 187.5;
    const demoTotalIncl = Number((demoPreTax * (1 + this.njSalesTaxPct / 100)).toFixed(2));
    const url = await this.writePendingOrderInvoicePdf(
      {
        id: "demo-sample-order",
        subtotal: demoTotalIncl,
        preTaxNet: demoPreTax,
        promoDiscountPreTax: 0,
        quantityLbs: 25,
        notes:
          "Beef & Organ Blend (Adult Dog)\nPackaging: vacuum-sealed bags — 5 lb units\n(Demo line item — totals below use this order’s numbers.)",
        customer: {
          name: "Demo Customer — Sample Invoice",
          email: "demo@jerseyraw.example",
          phone: "973-555-0100"
        },
        createdAt: new Date("2025-06-15T18:30:00.000Z")
      },
      {
        id: "DEMO-sample-invoice",
        invoiceNumber: "DEMO-20250615-SAMPLE"
      }
    );
    const localPath = join(this.invoicesUploadDir(), "DEMO-sample-invoice.pdf");
    return { url, path: url.startsWith("http") ? url : localPath };
  }

  /** Matches Invoice tab: line subtotal, discount, then tax on (subtotal - discount), total = taxable + tax. */
  private computeInvoiceSheetTotals(lineSubtotal: number, discount: number, taxRatePct: number) {
    const subtotal = Number(lineSubtotal || 0);
    const disc = Math.max(0, Number(discount || 0));
    const taxable = Math.max(0, subtotal - disc);
    const tax = taxable * (Number(taxRatePct || 0) / 100);
    const total = taxable + tax;
    return { subtotal, discount: disc, taxable, tax, total };
  }

  /**
   * `preTaxNet` = merchandise before coupon (when set — new orders with `recipeId` / promo).
   * Legacy rows: only `subtotal` exists and is **tax-included** total (Submit Order convention); infer pre-tax merchandise.
   */
  private orderMerchandiseAndDiscount(order: {
    subtotal: unknown;
    preTaxNet?: unknown | null;
    promoDiscountPreTax?: unknown | null;
  }): { merchandisePreTax: number; discountPreTax: number } {
    const discountPreTax = Math.max(0, Number(order.promoDiscountPreTax ?? 0));
    let merchandisePreTax: number;
    if (order.preTaxNet != null && order.preTaxNet !== undefined && String(order.preTaxNet) !== "") {
      merchandisePreTax = Math.max(0, Number(order.preTaxNet));
    } else {
      const stored = Math.max(0, Number(order.subtotal || 0));
      merchandisePreTax = stored / (1 + this.njSalesTaxPct / 100);
    }
    return { merchandisePreTax, discountPreTax };
  }

  private orderInvoiceTotals(order: {
    subtotal: unknown;
    preTaxNet?: unknown | null;
    promoDiscountPreTax?: unknown | null;
  }) {
    const { merchandisePreTax, discountPreTax } = this.orderMerchandiseAndDiscount(order);
    return this.computeInvoiceSheetTotals(merchandisePreTax, discountPreTax, this.njSalesTaxPct);
  }

  private invoicesUploadDir() {
    return getInvoicesDir();
  }

  /** Manual / Invoice-tab creates: sequential JR-YYYY-#### */
  private async nextInvoiceNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `JR-${year}-`;
    const existing = await this.prisma.invoice.findMany({
      where: { invoiceNumber: { startsWith: prefix } },
      select: { invoiceNumber: true }
    });
    let max = 0;
    for (const e of existing) {
      const m = /^JR-\d{4}-(\d+)$/.exec(e.invoiceNumber);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}${String(max + 1).padStart(4, "0")}`;
  }

  private digitsOnlyPhone(phone: string | null | undefined): string {
    const d = String(phone || "").replace(/\D/g, "");
    return d.length > 0 ? d : "nophone";
  }

  /**
   * Auto-generated invoices (pending + archive sync): number = order date (YYYY-MM-DD) + phone digits.
   * Example: 2025-03-23-7325551212. Same day + same phone → …-2, …-3. No phone → …-nophone.
   */
  private async nextAutoInvoiceNumberForOrder(order: {
    id: string;
    createdAt: Date;
    customer: { phone: string | null };
  }): Promise<string> {
    const dateStr = new Date(order.createdAt).toISOString().slice(0, 10);
    const phonePart = this.digitsOnlyPhone(order.customer.phone);
    const base = `${dateStr}-${phonePart}`;
    let candidate = base;
    for (let n = 0; n < 10_000; n++) {
      const clash = await this.prisma.invoice.findUnique({
        where: { invoiceNumber: candidate },
        select: { id: true }
      });
      if (!clash) return candidate;
      candidate = `${base}-${n + 2}`;
    }
    const safeId = order.id.replace(/[^a-zA-Z0-9-_]/g, "").slice(-24);
    return `${base}-${safeId || "id"}`;
  }

  /** PDFKit default fonts are WinAnsi — strip control chars and cap length to avoid write failures. */
  private pdfSafeText(raw: string, maxLen = 4000): string {
    return String(raw || "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")
      .slice(0, maxLen);
  }

  private sanitizeInvoiceArchiveFilename(invoiceNumber: string): string {
    return this.pdfSafeText(invoiceNumber.replace(/[/\\?%*:|"<>]/g, "-"), 180).trim() || "invoice";
  }

  /** Prefer explicit product summary, then notes first line, then generic label. */
  private invoiceRecipeLabelFromOrder(order: { productSummary?: string | null; notes: string | null }): string {
    const ps = String(order.productSummary || "").trim();
    if (ps) return this.pdfSafeText(ps, 100);
    const n = String(order.notes || "").trim();
    if (!n) return "Product order";
    const first = n.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
    if (first.length > 0 && first.length <= 100) return first;
    return "Product order";
  }

  private invoicePackagingFromNotes(notes: string | null): string {
    const n = String(notes || "");
    const m = /packaging\s*:\s*(.+)/i.exec(n);
    if (m) return this.pdfSafeText(m[1].split("\n")[0].trim(), 80);
    return "—";
  }

  private parseOrderInvoiceLines(order: {
    quantityLbs?: unknown;
    preTaxNet?: unknown | null;
    productSummary?: string | null;
    orderItemsJson?: string | null;
    notes: string | null;
  }): Array<{ recipe: string; qtyLbs: number; unitPrice: number; lineTotalPreTax: number }> {
    const fallbackQty = Math.max(0, Number(order.quantityLbs ?? 0));
    const fallbackPreTax = Math.max(0, Number(order.preTaxNet ?? 0));
    const fallbackRecipe = this.invoiceRecipeLabelFromOrder(order);
    const fallbackUnit = fallbackQty > 0 ? fallbackPreTax / fallbackQty : fallbackPreTax;
    const fallback = [{ recipe: fallbackRecipe, qtyLbs: fallbackQty, unitPrice: fallbackUnit, lineTotalPreTax: fallbackPreTax }];

    const raw = String(order.orderItemsJson || "").trim();
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as Array<{ recipeName?: string; quantityLbs?: number; unitPrice?: number; linePreTax?: number }>;
      if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
      const rows = parsed
        .map((x) => {
          const qty = Math.max(0, Number(x.quantityLbs ?? 0));
          const unit = Math.max(0, Number(x.unitPrice ?? 0));
          const line = Math.max(0, Number(x.linePreTax ?? qty * unit));
          const recipe = this.pdfSafeText(String(x.recipeName || "").trim() || "Product order", 100);
          return { recipe, qtyLbs: qty, unitPrice: unit, lineTotalPreTax: line };
        })
        .filter((x) => x.qtyLbs > 0 || x.lineTotalPreTax > 0);
      return rows.length > 0 ? rows : fallback;
    } catch {
      return fallback;
    }
  }

  private invoiceNjDateString(d: Date): string {
    return new Date(d).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "2-digit",
      day: "2-digit",
      year: "numeric"
    });
  }

  /** `INVOICE_LOGO_PATH` if that file exists; otherwise `Backend/Invoices/logo.png` (etc.). */
  private resolveInvoiceLogoAbsPath(): string {
    const configured = this.config.get<string>("INVOICE_LOGO_PATH")?.trim();
    if (configured) {
      const abs = resolve(configured);
      if (existsSync(abs)) return abs;
    }
    return resolveInvoiceLogoPathFromInvoicesDir() ?? "";
  }

  private async writePendingOrderInvoicePdf(order: {
    id: string;
    subtotal: unknown;
    preTaxNet?: unknown | null;
    promoDiscountPreTax?: unknown | null;
    quantityLbs?: unknown;
    productSummary?: string | null;
    orderItemsJson?: string | null;
    notes: string | null;
    customer: { name: string; email: string | null; phone: string | null };
    createdAt: Date;
    promoCode?: { code: string; label: string; kind: PromoKind } | null;
  }, invoice: { id: string; invoiceNumber: string }) {
    const BRAND = "#2f8f46";
    const CARD_BLUE = "#1a73e8";
    const taxRatePct = this.njSalesTaxPct;
    const { merchandisePreTax, discountPreTax } = this.orderMerchandiseAndDiscount(order);
    const totals = this.computeInvoiceSheetTotals(merchandisePreTax, discountPreTax, taxRatePct);
    const creditCardFeeRate = Number(this.config.get<string>("INVOICE_CREDIT_CARD_FEE_RATE") || "0.033");
    const feeRateSafe = Number.isFinite(creditCardFeeRate) && creditCardFeeRate >= 0 ? creditCardFeeRate : 0.033;

    const totalWithTax = totals.total;
    const totalTax = totals.tax;
    const subtotalPreTax = totals.taxable;
    const orderLines = this.parseOrderInvoiceLines(order);
    const creditCardFee = totalWithTax * feeRateSafe;
    const creditCardTotal = totalWithTax + creditCardFee;
    const feePctLabel = (feeRateSafe * 100).toFixed(1).replace(/\.0$/, "");

    const squareLink =
      this.config.get<string>("INVOICE_SQUARE_CHECKOUT_URL")?.trim() ||
      "https://checkout.square.site/merchant/ML7JBVQHNKGKX/checkout/PYFVIR4HXGKCJ2TPCDYNE2K3?src=sheet";
    const zelle = this.config.get<string>("INVOICE_ZELLE_EMAIL")?.trim() || "JerseyRawHelp@gmail.com";
    const venmo = this.config.get<string>("INVOICE_VENMO_HANDLE")?.trim() || "@Christopher-G1";
    const logoPath = this.resolveInvoiceLogoAbsPath();

    const dir = this.invoicesUploadDir();
    const archiveDir = getInvoicesArchiveDir();
    const fileName = `${invoice.id}.pdf`;
    const filePath = join(dir, fileName);
    const archiveName = `${this.sanitizeInvoiceArchiveFilename(invoice.invoiceNumber)}.pdf`;
    const archivePath = join(archiveDir, archiveName);
    const publicPath = `/uploads/invoices/${fileName}`;

    const invNo = this.pdfSafeText(invoice.invoiceNumber, 120);
    const cName = this.pdfSafeText(order.customer.name || "Customer", 200);
    const cEmail = order.customer.email ? this.pdfSafeText(order.customer.email, 200) : "";
    const cPhone = order.customer.phone ? this.pdfSafeText(String(order.customer.phone).replace(/\D/g, "") || order.customer.phone, 40) : "";
    const packaging = this.invoicePackagingFromNotes(order.notes);

    const doc = new PDFKit({ margin: 50, size: "LETTER" });
    const pt = new PassThrough();
    const chunks: Buffer[] = [];
    pt.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.pipe(pt);

    const pageW = doc.page.width;
    const left = 50;
    const right = pageW - 50;
    const contentW = right - left;

    doc.save();
    doc.rect(0, 0, pageW, 8).fill(BRAND);
    doc.restore();

    let y = 28;
    const headerTop = y;

    if (logoPath && existsSync(logoPath)) {
      try {
        doc.image(logoPath, left, y, { fit: [200, 72] });
        y += 78;
      } catch {
        y = headerTop;
      }
    }

    doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(16).text("JERSEY RAW LLC", left, y);
    y += 22;
    doc.fillColor("#333333").font("Helvetica").fontSize(10);
    doc.text("JerseyRawHelp@gmail.com", left, y);
    y += 14;
    doc.text("JerseyRaw.com", left, y);
    y += 14;
    doc.text("973-532-2247", left, y);
    y += 6;

    const metaX = left + 280;
    let metaY = headerTop;
    doc.fillColor("#333333").font("Helvetica").fontSize(10);
    doc.font("Helvetica-Bold").text("Invoice #", metaX, metaY, { width: contentW - 280, align: "right" });
    doc.font("Helvetica").text(invNo, metaX, metaY + 12, { width: contentW - 280, align: "right" });
    metaY += 30;
    doc.font("Helvetica-Bold").text("Date", metaX, metaY, { width: contentW - 280, align: "right" });
    doc
      .font("Helvetica")
      .text(this.invoiceNjDateString(new Date(order.createdAt)), metaX, metaY + 12, { width: contentW - 280, align: "right" });

    const isDemoSample = invoice.invoiceNumber.startsWith("DEMO-");
    if (isDemoSample) {
      doc
        .fillColor("#b45309")
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("SAMPLE — preview only (not a real charge)", metaX, metaY + 28, { width: contentW - 280, align: "right" });
    }

    y = Math.max(y, metaY + (isDemoSample ? 52 : 36));
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#e5efe9").lineWidth(0.5).stroke();
    y += 16;

    doc.fillColor("#333333").font("Helvetica-Bold").fontSize(11).text("BILL TO", left, y);
    y += 16;
    doc.font("Helvetica").fontSize(10);
    doc.text(cName, left, y);
    y += 14;
    if (cEmail) {
      doc.text(cEmail, left, y);
      y += 14;
    }
    if (cPhone) {
      doc.text(cPhone, left, y);
      y += 14;
    }
    y += 8;

    doc.font("Helvetica-Bold").fontSize(11).text("ORDER DETAILS", left, y);
    y += 18;

    const colRecipe = left;
    const colPack = left + 180;
    const colQty = left + 280;
    const colPrice = left + 360;
    const colLineTotal = left + 450;
    const rowH = 22;

    doc.save();
    doc.rect(left, y, contentW, rowH).fill(BRAND);
    doc.restore();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("Recipe", colRecipe + 6, y + 7, { width: 170 });
    doc.text("Packaging", colPack + 6, y + 7, { width: 90, align: "center" });
    doc.text("Qty (lb)", colQty + 6, y + 7, { width: 70, align: "center" });
    doc.text("Price / unit", colPrice + 6, y + 7, { width: 80, align: "right" });
    doc.text("Line total", colLineTotal + 6, y + 7, { width: contentW - (colLineTotal - left) - 8, align: "right" });
    y += rowH;

    doc.fillColor("#333333").font("Helvetica").fontSize(10);
    for (const line of orderLines) {
      doc.text(this.pdfSafeText(line.recipe, 100), colRecipe + 6, y + 6, { width: 170 });
      doc.text(packaging, colPack + 6, y + 6, { width: 90, align: "center" });
      doc.text(line.qtyLbs > 0 ? line.qtyLbs.toFixed(2) : "—", colQty + 6, y + 6, { width: 70, align: "center" });
      doc.text(`$${line.unitPrice.toFixed(2)}`, colPrice + 6, y + 6, { width: 80, align: "right" });
      doc.text(`$${line.lineTotalPreTax.toFixed(2)}`, colLineTotal + 6, y + 6, { width: contentW - (colLineTotal - left) - 8, align: "right" });
      y += rowH;
      doc.moveTo(left, y).lineTo(right, y).strokeColor("#eeeeee").stroke();
    }
    y += 12;

    const boxLeft = left + 200;
    const boxW = contentW - 200;
    const labelW = 150;
    const moneyW = boxW - labelW - 10;

    const rowMoney = (label: string, amount: string, opts?: { bold?: boolean; color?: string }) => {
      doc.fillColor(opts?.color ?? "#333333").font(opts?.bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      doc.text(label, boxLeft, y, { width: labelW, align: "right" });
      doc.text(amount, boxLeft + labelW + 4, y, { width: moneyW, align: "right" });
      y += 16;
    };

    rowMoney("Merchandise (pre-tax):", `$${merchandisePreTax.toFixed(2)}`);
    if (discountPreTax > 0) {
      const dLabel = order.promoCode?.code ? `Discount (${order.promoCode.code}):` : "Discount:";
      rowMoney(dLabel, `-$${discountPreTax.toFixed(2)}`, { color: "#b45309" });
    }
    rowMoney("Taxable subtotal:", `$${subtotalPreTax.toFixed(2)}`);
    rowMoney("Sales Tax:", `$${totalTax.toFixed(2)}`);
    rowMoney("Cash / Zelle / Venmo total:", `$${totalWithTax.toFixed(2)}`, { bold: true, color: BRAND });
    rowMoney(`Card fee (${feePctLabel}%):`, `$${creditCardFee.toFixed(2)}`);
    rowMoney("Credit card total:", `$${creditCardTotal.toFixed(2)}`, { bold: true, color: CARD_BLUE });
    y += 14;

    const payBox = (bg: string, border: string, lines: string[], boldLast?: string, lastLineIsLink?: boolean) => {
      const lineGap = 13;
      const h = 16 + lines.length * lineGap + (boldLast ? 18 : 0);
      doc.save();
      doc.rect(left, y, contentW, h).fill(bg);
      doc.rect(left, y, 4, h).fill(border);
      doc.restore();
      let py = y + 10;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isLinkLine = Boolean(lastLineIsLink && i === lines.length - 1);
        doc
          .fillColor(isLinkLine ? CARD_BLUE : "#333333")
          .font("Helvetica")
          .fontSize(isLinkLine ? 8 : 10)
          .text(line, left + 14, py, { width: contentW - 24, link: isLinkLine ? line : undefined, underline: isLinkLine });
        py += lineGap;
      }
      if (boldLast) {
        doc.fillColor(border).font("Helvetica-Bold").fontSize(10).text(boldLast, left + 14, py, { width: contentW - 24 });
      }
      y += h + 10;
    };

    payBox(
      "#eef9f1",
      BRAND,
      [`Pay cash / Zelle / Venmo`, `Zelle: ${zelle}`, `Venmo: ${venmo}`, `Cash accepted at pickup`],
      `Amount due: $${totalWithTax.toFixed(2)}`
    );

    payBox(
      "#eef4ff",
      CARD_BLUE,
      [`Pay by credit card (${feePctLabel}% processing included)`, `Amount due by card: $${creditCardTotal.toFixed(2)}`, squareLink],
      "",
      true
    );

    if (order.promoCode?.kind === PromoKind.COOP) {
      doc
        .fillColor("#1e40af")
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(
          `Co-op referral: ${this.pdfSafeText(order.promoCode.label, 120)} (${this.pdfSafeText(order.promoCode.code, 40)}) — thank you for ordering through your co-op.`,
          left,
          y,
          { width: contentW, align: "left" }
        );
      y += 28;
    }

    if (order.notes?.trim()) {
      doc.fillColor("#555555").font("Helvetica").fontSize(9);
      doc.text(`Notes: ${this.pdfSafeText(order.notes.trim(), 2000)}`, left, y, { width: contentW, align: "left" });
      y += 36;
    }

    doc.fillColor("#555555").font("Helvetica").fontSize(10).text("Thank you for supporting local, species-appropriate nutrition.", left, y, {
      width: contentW,
      align: "center"
    });

    doc.end();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      pt.once("error", rejectPromise);
      doc.once("error", rejectPromise);
      void once(pt, "finish").then(() => resolvePromise()).catch(rejectPromise);
    });
    const pdfBuf = Buffer.concat(chunks);

    if (this.storage.usesObjectStorage()) {
      const kPrimary = this.storage.invoicePrimaryKey(invoice.id);
      const kArchive = this.storage.invoiceArchiveObjectKey(archiveName);
      await this.storage.putPdf(kPrimary, pdfBuf);
      try {
        await this.storage.putPdf(kArchive, pdfBuf);
      } catch {
        /* archive best-effort */
      }
      return this.storage.publicUrlForKey(kPrimary);
    }

    this.storage.writeLocalInvoicePdf(filePath, archivePath, pdfBuf);
    return publicPath;
  }

  async saveExpenseReceiptUpload(file: Express.Multer.File): Promise<{ receiptPath: string }> {
    const safeExt = extname(file.originalname || "").toLowerCase() || ".bin";
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`;
    if (this.storage.usesObjectStorage()) {
      const key = this.storage.expenseKey(name);
      await this.storage.putObject(key, file.buffer, file.mimetype || "application/octet-stream");
      return { receiptPath: this.storage.publicUrlForKey(key) };
    }
    const dest = join(getExpensesUploadDir(), name);
    this.storage.writeLocalExpenseReceipt(dest, file.buffer);
    return { receiptPath: `/uploads/expenses/${name}` };
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
    return this.prisma.order.findMany({
      take: 25,
      include: { customer: true, recipe: true, promoCode: true, invoice: { include: { payment: true } } },
      orderBy: { createdAt: "desc" }
    });
  }

  async getOverview() {
    const [customerCount, orderCount, expenseCount, recipeCount, ingredientCount] = await Promise.all([
      this.prisma.customer.count(),
      this.prisma.order.count(),
      this.prisma.expense.count(),
      this.prisma.recipe.count(),
      this.prisma.ingredient.count()
    ]);
    return { customerCount, orderCount, expenseCount, recipeCount, ingredientCount };
  }

  listCustomers() {
    return this.prisma.customer.findMany({ orderBy: { createdAt: "desc" } });
  }

  createCustomer(data: { name: string; email?: string; phone?: string }) {
    return this.prisma.customer.create({ data });
  }

  updateCustomer(customerId: string, data: { name: string; email?: string; phone?: string }) {
    return this.prisma.customer.update({
      where: { id: customerId },
      data: {
        name: String(data.name || "").trim(),
        email: String(data.email || "").trim() || null,
        phone: String(data.phone || "").trim() || null
      }
    });
  }

  listIngredients() {
    return this.prisma.ingredient.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
  }

  createIngredient(data: {
    name: string;
    category: string;
    unit: string;
    quantityOnHand: number;
    totalCost: number;
    percentAdded: number;
    chargePerPound: number;
  }) {
    const quantity = Number(data.quantityOnHand || 0);
    const cost = Number(data.totalCost || 0);
    const pricePerLb = quantity > 0 ? cost / quantity : 0;
    const markupPercent = pricePerLb > 0 ? ((Number(data.chargePerPound || 0) - pricePerLb) / pricePerLb) * 100 : 0;
    return this.prisma.ingredient.create({
      data: {
        name: data.name.trim(),
        category: data.category?.trim() || "Uncategorized",
        unit: data.unit.trim(),
        quantityOnHand: quantity,
        totalCost: cost,
        pricePerLb,
        percentAdded: Number(data.percentAdded || 0),
        markupPercent,
        chargePerPound: Number(data.chargePerPound || 0),
        defaultCost: pricePerLb
      }
    });
  }

  async purchaseIngredient(data: { ingredientId: string; addedQuantity: number; addedCost: number }) {
    const ingredient = await this.prisma.ingredient.findUniqueOrThrow({ where: { id: data.ingredientId } });
    const nextQty = Number(ingredient.quantityOnHand) + Number(data.addedQuantity || 0);
    const nextCost = Number(ingredient.totalCost) + Number(data.addedCost || 0);
    const nextPricePerLb = nextQty > 0 ? nextCost / nextQty : 0;
    const nextMarkupPercent = nextPricePerLb > 0 ? ((Number(ingredient.chargePerPound) - nextPricePerLb) / nextPricePerLb) * 100 : 0;

    return this.prisma.ingredient.update({
      where: { id: data.ingredientId },
      data: {
        quantityOnHand: nextQty,
        totalCost: nextCost,
        pricePerLb: nextPricePerLb,
        defaultCost: nextPricePerLb,
        markupPercent: nextMarkupPercent
      }
    });
  }

  async adjustIngredientQuantity(data: { ingredientId: string; quantityDelta: number }) {
    const ingredient = await this.prisma.ingredient.findUniqueOrThrow({ where: { id: data.ingredientId } });
    const nextQty = Math.max(0, Number(ingredient.quantityOnHand) + Number(data.quantityDelta || 0));
    const currentPricePerLb = Number(ingredient.pricePerLb);
    const nextTotalCost = nextQty * currentPricePerLb;
    const nextMarkupPercent =
      currentPricePerLb > 0 ? ((Number(ingredient.chargePerPound) - currentPricePerLb) / currentPricePerLb) * 100 : 0;
    return this.prisma.ingredient.update({
      where: { id: data.ingredientId },
      data: {
        quantityOnHand: nextQty,
        totalCost: nextTotalCost,
        markupPercent: nextMarkupPercent
      }
    });
  }

  async updateIngredientPricing(data: {
    ingredientId: string;
    percentAdded: number;
    chargePerPound: number;
    category?: string;
  }) {
    const ingredient = await this.prisma.ingredient.findUniqueOrThrow({ where: { id: data.ingredientId } });
    const pricePerLb = Number(ingredient.pricePerLb);
    const markupPercent = pricePerLb > 0 ? ((Number(data.chargePerPound) - pricePerLb) / pricePerLb) * 100 : 0;
    return this.prisma.ingredient.update({
      where: { id: data.ingredientId },
      data: {
        category: data.category?.trim() || ingredient.category,
        percentAdded: Number(data.percentAdded || 0),
        chargePerPound: Number(data.chargePerPound || 0),
        markupPercent
      }
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
    const ingredient = await this.prisma.ingredient.findUniqueOrThrow({ where: { id: data.ingredientId } });
    const quantityOnHand = Math.max(0, Number(data.quantityOnHand || 0));
    const totalCost = Math.max(0, Number(data.totalCost || 0));
    const chargePerPound = Math.max(0, Number(data.chargePerPound || 0));
    const pricePerLb = quantityOnHand > 0 ? totalCost / quantityOnHand : 0;
    const markupPercent = pricePerLb > 0 ? ((chargePerPound - pricePerLb) / pricePerLb) * 100 : 0;
    return this.prisma.ingredient.update({
      where: { id: data.ingredientId },
      data: {
        category: data.category?.trim() || ingredient.category,
        quantityOnHand,
        totalCost,
        pricePerLb,
        defaultCost: pricePerLb,
        chargePerPound,
        percentAdded: Number(data.percentAdded ?? ingredient.percentAdded),
        markupPercent
      }
    });
  }

  async makeRecipeBatch(data: { recipeId: string; batchLbs: number }) {
    const batchLbs = Number(data.batchLbs || 0);
    if (!Number.isFinite(batchLbs) || batchLbs <= 0) {
      throw new Error("batchLbs must be greater than 0.");
    }

    return this.prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.findUnique({
        where: { id: data.recipeId },
        include: { ingredients: { include: { ingredient: true } }, bundleItems: true }
      });
      if (!recipe) throw new Error("Recipe not found.");
      if (recipe.isBundle) throw new Error("Bundle recipes cannot be made directly. Make component recipes first.");
      if (!recipe.ingredients.length) throw new Error("Recipe has no ingredient mix.");

      const usages = recipe.ingredients.map((ri) => {
        const ratioPct = this.normalizeRecipeRatioPercent(ri.quantity);
        const neededLbs = (ratioPct / 100) * batchLbs;
        const onHand = Number(ri.ingredient.quantityOnHand || 0);
        return {
          ingredientId: ri.ingredientId,
          ingredientName: ri.ingredient.name,
          ratioPct,
          neededLbs,
          onHandLbs: onHand
        };
      });

      const insufficient = usages.filter((u) => u.neededLbs > u.onHandLbs + 1e-9);
      if (insufficient.length) {
        throw new Error(
          `Insufficient inventory: ${insufficient
            .map((u) => `${u.ingredientName} needs ${u.neededLbs.toFixed(2)} lb, has ${u.onHandLbs.toFixed(2)} lb`)
            .join("; ")}`
        );
      }

      for (const u of usages) {
        const ingredient = await tx.ingredient.findUniqueOrThrow({ where: { id: u.ingredientId } });
        const currentQty = Number(ingredient.quantityOnHand || 0);
        const currentCost = Number(ingredient.totalCost || 0);
        const currentPricePerLb = currentQty > 0 ? currentCost / currentQty : Number(ingredient.pricePerLb || 0);
        const nextQty = Math.max(0, currentQty - u.neededLbs);
        const nextCost = Math.max(0, currentCost - currentPricePerLb * u.neededLbs);
        const nextPricePerLb = nextQty > 0 ? nextCost / nextQty : currentPricePerLb;
        const nextMarkupPercent = nextPricePerLb > 0 ? ((Number(ingredient.chargePerPound) - nextPricePerLb) / nextPricePerLb) * 100 : 0;

        await tx.ingredient.update({
          where: { id: u.ingredientId },
          data: {
            quantityOnHand: nextQty,
            totalCost: nextCost,
            pricePerLb: nextPricePerLb,
            defaultCost: nextPricePerLb,
            markupPercent: nextMarkupPercent
          }
        });
      }

      return {
        recipeId: recipe.id,
        recipeName: recipe.name,
        batchLbs,
        usages: usages.map((u) => ({
          ingredientId: u.ingredientId,
          ingredientName: u.ingredientName,
          ratioPct: u.ratioPct,
          usedLbs: Number(u.neededLbs.toFixed(4))
        }))
      };
    });
  }

  listRecipes() {
    return this.prisma.recipe.findMany({
      include: {
        ingredients: { include: { ingredient: true } },
        bundleItems: { include: { childRecipe: true } }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  createExpense(data: {
    vendor: string;
    category: string;
    amount: number;
    expenseDate: string;
    receiptPath?: string;
    notes?: string;
  }) {
    return this.prisma.expense.create({
      data: {
        vendor: data.vendor,
        category: this.normalizeExpenseCategory(data.category, `${data.vendor} ${data.notes || ""}`),
        amount: data.amount,
        expenseDate: new Date(data.expenseDate),
        receiptPath: data.receiptPath,
        notes: data.notes
      }
    });
  }

  listExpenses() {
    return this.prisma.expense.findMany({ orderBy: { expenseDate: "desc" } });
  }

  recategorizeExpense(data: { expenseId: string; category: string }) {
    // Manual recategorize keeps the same normalization behavior for consistency.
    return this.prisma.expense.update({
      where: { id: data.expenseId },
      data: { category: this.normalizeExpenseCategory(data.category) }
    });
  }

  updateExpense(
    expenseId: string,
    data: { vendor: string; category: string; amount: number; expenseDate: string; receiptPath?: string; notes?: string }
  ) {
    const vendor = String(data.vendor || "").trim();
    const notes = String(data.notes || "").trim();
    return this.prisma.expense.update({
      where: { id: expenseId },
      data: {
        vendor,
        category: this.normalizeExpenseCategory(data.category, `${vendor} ${notes}`),
        amount: Number(data.amount || 0),
        expenseDate: new Date(data.expenseDate),
        receiptPath: data.receiptPath?.trim() || null,
        notes: notes || null
      }
    });
  }

  async bulkImportExpenses(
    rows: Array<{ expenseDate: string; vendor: string; description?: string; category: string; amount: number; payment?: string; receipt?: string }>
  ) {
    let created = 0;
    for (const row of rows) {
      const date = row.expenseDate?.trim();
      const vendor = row.vendor?.trim();
      if (!date || !vendor || !Number.isFinite(row.amount)) continue;
      const notes = [row.description?.trim(), row.payment?.trim()].filter(Boolean).join(" | ");
      await this.prisma.expense.create({
        data: {
          expenseDate: new Date(date),
          vendor,
          category: this.normalizeExpenseCategory(row.category, `${vendor} ${row.description || ""} ${row.payment || ""}`),
          amount: Number(row.amount),
          notes: notes || undefined,
          receiptPath: row.receipt?.trim() || undefined
        }
      });
      created += 1;
    }
    return { created };
  }

  async normalizeAllExpenseCategories() {
    const rows = await this.prisma.expense.findMany();
    let updated = 0;
    for (const row of rows) {
      const next = this.normalizeExpenseCategory(row.category, `${row.vendor} ${row.notes || ""}`);
      if (next !== row.category) {
        await this.prisma.expense.update({ where: { id: row.id }, data: { category: next } });
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
    return this.prisma.recipe.create({
      data: {
        ...data,
        foodType: data.foodType?.trim() || "Adult",
        chargeUnit: data.chargeUnit === "bag" ? "bag" : "lb",
        amountPerUnit: Math.max(0.01, Number(data.amountPerUnit || 1))
      }
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
    const ingredients = this.normalizeRecipeLines(data.ingredients);
    const bundleItems = this.normalizeRecipeLines(data.bundleItems);
    if (!Boolean(data.isBundle) && ingredients.length === 0) {
      throw new BadRequestException("Recipe must include at least one ingredient with quantity greater than 0.");
    }
    return this.prisma.recipe.create({
      data: {
        name: data.name,
        description: data.description,
        foodType: data.foodType?.trim() || "Adult",
        costPerPound: data.costPerPound,
        salePrice: data.salePrice,
        chargeUnit: data.chargeUnit === "bag" ? "bag" : "lb",
        amountPerUnit: Math.max(0.01, Number(data.amountPerUnit || 1)),
        isBundle: Boolean(data.isBundle),
        ingredients: {
          create: ingredients.map((item) => ({
            ingredientId: item.ingredientId,
            quantity: item.quantity
          }))
        },
        bundleItems: {
          create: bundleItems.map((item) => ({
            childRecipeId: item.ingredientId,
            quantity: item.quantity
          }))
        }
      },
      include: {
        ingredients: { include: { ingredient: true } },
        bundleItems: { include: { childRecipe: true } }
      }
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
    const ingredients = this.normalizeRecipeLines(data.ingredients);
    const bundleItems = this.normalizeRecipeLines(data.bundleItems);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.recipe.update({
        where: { id: recipeId },
        data: {
          name: data.name,
          description: data.description,
          foodType: data.foodType?.trim() || "Adult",
          costPerPound: data.costPerPound,
          salePrice: data.salePrice,
          chargeUnit: data.chargeUnit === "bag" ? "bag" : "lb",
          amountPerUnit: Math.max(0.01, Number(data.amountPerUnit || 1)),
          isBundle: Boolean(data.isBundle)
        }
      });

      await tx.recipeBundleItem.deleteMany({ where: { recipeId } });

      // Only replace ingredient mix when valid ingredient lines are submitted.
      // This prevents accidental wipeouts when a client payload is malformed.
      if (ingredients.length > 0) {
        await tx.recipeIngredient.deleteMany({ where: { recipeId } });
        await tx.recipeIngredient.createMany({
          data: ingredients.map((item) => ({
            recipeId,
            ingredientId: item.ingredientId,
            quantity: item.quantity
          }))
        });
      }

      if (bundleItems.length > 0) {
        await tx.recipeBundleItem.createMany({
          data: bundleItems.map((item) => ({
            recipeId,
            childRecipeId: item.ingredientId,
            quantity: item.quantity
          }))
        });
      }

      return tx.recipe.findUnique({
        where: { id: updated.id },
        include: {
          ingredients: { include: { ingredient: true } },
          bundleItems: { include: { childRecipe: true } }
        }
      });
    });
  }

  deleteRecipe(recipeId: string) {
    return this.prisma.recipe.delete({ where: { id: recipeId } });
  }

  addRecipeIngredient(data: { recipeId: string; ingredientId: string; quantity: number }) {
    return this.prisma.recipeIngredient.upsert({
      where: { recipeId_ingredientId: { recipeId: data.recipeId, ingredientId: data.ingredientId } },
      update: { quantity: data.quantity },
      create: data
    });
  }

  listInventory() {
    return this.prisma.inventoryLot.findMany({ orderBy: { receivedAt: "desc" } });
  }

  createInventoryLot(data: { ingredient: string; quantityLbs: number; unitCost: number; receivedAt: string }) {
    return this.prisma.inventoryLot.create({
      data: {
        ingredient: data.ingredient,
        quantityLbs: data.quantityLbs,
        unitCost: data.unitCost,
        receivedAt: new Date(data.receivedAt)
      }
    });
  }

  listOrders() {
    return this.prisma.order.findMany({
      include: { customer: true, recipe: true, promoCode: true, invoice: { include: { payment: true } } },
      orderBy: { createdAt: "desc" }
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
    const status = data.status ?? OrderStatus.NEW;
    const tender = data.paymentMethod?.trim() || null;
    const isPaidOnCreate = Boolean(tender);
    const paidAtOnCreate = isPaidOnCreate ? new Date() : null;
    const lbs = Number(data.quantityLbs || 0);
    const itemLines = (data.items || []).filter((x) => String(x?.recipeId || "").trim() && Number(x?.quantityLbs || 0) > 0);

    let preTaxNet: number;
    let cogsVal: number;
    let recipeId: string | null = data.recipeId?.trim() || null;
    let totalLbs = lbs;
    let productSummary = "";
    let orderItemsJson: string | null = null;

    if (itemLines.length > 0) {
      preTaxNet = 0;
      cogsVal = 0;
      totalLbs = 0;
      recipeId = null; // multi-item orders are stored as a combined order snapshot
      const summaryParts: string[] = [];
      const jsonRows: Array<{ recipeName: string; quantityLbs: number; unitPrice: number; linePreTax: number }> = [];
      for (const item of itemLines) {
        const rid = String(item.recipeId || "").trim();
        const ilbs = Number(item.quantityLbs || 0);
        if (!rid || !(ilbs > 0)) continue;
        const recipe = await this.prisma.recipe.findUnique({ where: { id: rid } });
        if (!recipe) throw new BadRequestException(`Invalid recipeId in items: ${rid}`);
        const unit = String(recipe.chargeUnit ?? "lb");
        const amountPerUnit = Math.max(0.01, Number(recipe.amountPerUnit ?? 1));
        const chargePerLb = unit === "bag" ? Number(recipe.salePrice) / amountPerUnit : Number(recipe.salePrice);
        const costPerLb = Number(recipe.costPerPound || 0);
        preTaxNet += ilbs * chargePerLb;
        cogsVal += ilbs * costPerLb;
        totalLbs += ilbs;
        const unitLabel = unit === "bag" ? "bag(s)" : "lb";
        summaryParts.push(`${recipe.name} - ${ilbs} ${unitLabel}`);
        jsonRows.push({
          recipeName: recipe.name,
          quantityLbs: ilbs,
          unitPrice: Number(chargePerLb.toFixed(4)),
          linePreTax: Number((ilbs * chargePerLb).toFixed(4))
        });
      }
      if (!(totalLbs > 0)) throw new BadRequestException("Order items must include at least one valid recipe and quantity.");
      productSummary = summaryParts.join(" | ");
      orderItemsJson = JSON.stringify(jsonRows);
    } else {
      if (recipeId) {
        const recipe = await this.prisma.recipe.findUnique({ where: { id: recipeId } });
        if (!recipe) throw new BadRequestException("Invalid recipeId.");
        const unit = String(recipe.chargeUnit ?? "lb");
        const amountPerUnit = Math.max(0.01, Number(recipe.amountPerUnit ?? 1));
        const chargePerLb = unit === "bag" ? Number(recipe.salePrice) / amountPerUnit : Number(recipe.salePrice);
        const costPerLb = Number(recipe.costPerPound || 0);
        preTaxNet = lbs * chargePerLb;
        cogsVal = lbs * costPerLb;
        const unitLabel = unit === "bag" ? "bag(s)" : "lb";
        productSummary = `${recipe.name} - ${lbs} ${unitLabel}`;
        orderItemsJson = JSON.stringify([
          {
            recipeName: recipe.name,
            quantityLbs: lbs,
            unitPrice: Number(chargePerLb.toFixed(4)),
            linePreTax: Number((lbs * chargePerLb).toFixed(4))
          }
        ]);
      } else {
        recipeId = null;
        const storedIncl = Math.max(0, Number(data.subtotal));
        preTaxNet = storedIncl / (1 + this.njSalesTaxPct / 100);
        cogsVal = Number(data.cogs ?? 0);
        productSummary = "";
        orderItemsJson = null;
      }
    }

    let promoDiscountPreTax = 0;
    let coOpKickbackOwed = 0;
    let promoCodeId: string | null = null;
    let promoCodeEntered: string | null = null;

    const rawPromo = data.promoCode?.trim();
    if (rawPromo) {
      const codeUpper = rawPromo.toUpperCase();
      const promo = await this.prisma.promoCode.findUnique({ where: { code: codeUpper } });
      if (!promo?.active) throw new BadRequestException("Invalid or inactive promo / co-op code.");
      promoCodeId = promo.id;
      promoCodeEntered = rawPromo;

      if (promo.kind === PromoKind.COUPON) {
        const pct = promo.discountPercent != null ? Number(promo.discountPercent) : 0;
        const fix = promo.discountFixed != null ? Number(promo.discountFixed) : 0;
        let disc = 0;
        if (pct > 0) disc += (preTaxNet * pct) / 100;
        if (fix > 0) disc += fix;
        promoDiscountPreTax = Math.min(preTaxNet, Math.max(0, disc));
      } else if (promo.kind === PromoKind.COOP) {
        const kp = promo.kickbackPercent != null ? Number(promo.kickbackPercent) : 0;
        const kf = promo.kickbackFixed != null ? Number(promo.kickbackFixed) : 0;
        coOpKickbackOwed = Math.max(0, (preTaxNet * kp) / 100 + kf);
      }
    }

    const postDiscountPreTax = Math.max(0, preTaxNet - promoDiscountPreTax);
    const tax = postDiscountPreTax * (this.njSalesTaxPct / 100);
    const finalSubtotalInclTax = Number((postDiscountPreTax + tax).toFixed(2));

    const order = await this.prisma.order.create({
      data: {
        customerId: data.customerId,
        recipeId,
        promoCodeId,
        promoCodeEntered,
        preTaxNet,
        promoDiscountPreTax,
        coOpKickbackOwed,
        quantityLbs: totalLbs,
        paymentStatus: isPaidOnCreate ? "PAID" : "UNPAID",
        paymentMethod: tender,
        paidAt: paidAtOnCreate,
        subtotal: finalSubtotalInclTax,
        cogs: cogsVal,
        margin: null,
        productSummary: productSummary || null,
        orderItemsJson,
        status,
        notes: data.notes?.trim() || null
      },
      include: { customer: true, promoCode: true }
    });
    if (status === OrderStatus.NEW || status === OrderStatus.CONFIRMED) {
      await this.ensureInvoiceForPendingOrder(order.id);
      if (isPaidOnCreate) {
        const inv = await this.prisma.invoice.findUnique({
          where: { orderId: order.id },
          select: { id: true, amount: true }
        });
        if (inv) {
          await this.prisma.payment.upsert({
            where: { invoiceId: inv.id },
            update: {
              amount: Number(inv.amount),
              status: "PAID",
              paidAt: paidAtOnCreate ?? new Date()
            },
            create: {
              invoiceId: inv.id,
              amount: Number(inv.amount),
              status: "PAID",
              paidAt: paidAtOnCreate ?? new Date()
            }
          });
        }
      }
    }
    return this.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { customer: true, recipe: true, promoCode: true, invoice: { include: { payment: true } } }
    });
  }

  updateOrderStatus(data: { orderId: string; status: OrderStatus }) {
    return this.prisma.order.update({
      where: { id: data.orderId },
      data: { status: data.status },
      include: { customer: true, invoice: { include: { payment: true } } }
    });
  }

  /**
   * After subtotal/notes/etc. change on a pending order, keep invoice amount + PDF in sync.
   * No-op for non-pending orders.
   */
  async refreshPendingOrderInvoice(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true, invoice: true, promoCode: true }
    });
    if (!order) return;
    if (order.status !== OrderStatus.NEW && order.status !== OrderStatus.CONFIRMED) return;

    const totals = this.orderInvoiceTotals(order);

    if (!order.invoice) {
      await this.ensureInvoiceForPendingOrder(orderId);
      return;
    }

    await this.prisma.invoice.update({
      where: { id: order.invoice.id },
      data: { amount: totals.total }
    });
    const pdfPath = await this.writePendingOrderInvoicePdf(
      { ...order, promoCode: order.promoCode },
      order.invoice
    );
    await this.prisma.invoice.update({
      where: { id: order.invoice.id },
      data: { pdfPath }
    });
  }

  async updateOrder(orderId: string, data: { quantityLbs?: number; subtotal?: number; cogs?: number; margin?: number; notes?: string }) {
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        quantityLbs: data.quantityLbs ?? undefined,
        subtotal: data.subtotal ?? undefined,
        cogs: data.cogs ?? undefined,
        margin: data.margin ?? undefined,
        notes: data.notes !== undefined ? (data.notes.trim() || null) : undefined
      }
    });
    await this.refreshPendingOrderInvoice(orderId);
    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { customer: true, invoice: { include: { payment: true } } }
    });
  }

  async updateOrderItems(orderId: string, data: { items: Array<{ recipeId: string; quantityLbs: number }>; notes?: string }) {
    const lines = (data.items || []).filter((x) => String(x?.recipeId || "").trim() && Number(x?.quantityLbs || 0) > 0);
    if (lines.length === 0) throw new BadRequestException("At least one recipe line is required.");

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { customer: true, promoCode: true, invoice: { include: { payment: true } } }
      });
      if (!order) throw new BadRequestException("Order not found.");
      if (!order.customer) throw new BadRequestException("Order missing customer.");
      if (order.status === OrderStatus.CANCELLED) throw new BadRequestException("Cannot edit cancelled order.");

      let preTaxNet = 0;
      let cogsVal = 0;
      let totalLbs = 0;
      const summaryParts: string[] = [];
      const jsonRows: Array<{ recipeName: string; quantityLbs: number; unitPrice: number; linePreTax: number }> = [];
      for (const line of lines) {
        const rid = String(line.recipeId || "").trim();
        const lbs = Number(line.quantityLbs || 0);
        const recipe = await tx.recipe.findUnique({ where: { id: rid } });
        if (!recipe) throw new BadRequestException(`Invalid recipeId: ${rid}`);
        const unit = String(recipe.chargeUnit ?? "lb");
        const amountPerUnit = Math.max(0.01, Number(recipe.amountPerUnit ?? 1));
        const chargePerLb = unit === "bag" ? Number(recipe.salePrice) / amountPerUnit : Number(recipe.salePrice);
        const costPerLb = Number(recipe.costPerPound || 0);
        preTaxNet += lbs * chargePerLb;
        cogsVal += lbs * costPerLb;
        totalLbs += lbs;
        summaryParts.push(`${recipe.name} - ${lbs} ${unit === "bag" ? "bag(s)" : "lb"}`);
        jsonRows.push({
          recipeName: recipe.name,
          quantityLbs: lbs,
          unitPrice: Number(chargePerLb.toFixed(4)),
          linePreTax: Number((lbs * chargePerLb).toFixed(4))
        });
      }

      let discountPreTax = 0;
      let coopKickback = 0;
      if (order.promoCode?.active) {
        if (order.promoCode.kind === PromoKind.COUPON) {
          const pct = Number(order.promoCode.discountPercent || 0);
          const fix = Number(order.promoCode.discountFixed || 0);
          discountPreTax = Math.min(preTaxNet, Math.max(0, (pct > 0 ? (preTaxNet * pct) / 100 : 0) + (fix > 0 ? fix : 0)));
        } else if (order.promoCode.kind === PromoKind.COOP) {
          const kp = Number(order.promoCode.kickbackPercent || 0);
          const kf = Number(order.promoCode.kickbackFixed || 0);
          coopKickback = Math.max(0, (preTaxNet * kp) / 100 + kf);
        }
      }
      const netAfterDiscount = Math.max(0, preTaxNet - discountPreTax);
      const tax = netAfterDiscount * (this.njSalesTaxPct / 100);
      const subtotal = Number((netAfterDiscount + tax).toFixed(2));

      await tx.order.update({
        where: { id: orderId },
        data: {
          recipeId: null,
          quantityLbs: totalLbs,
          preTaxNet,
          promoDiscountPreTax: discountPreTax,
          coOpKickbackOwed: coopKickback,
          subtotal,
          cogs: cogsVal,
          margin: null,
          productSummary: summaryParts.join(" | "),
          orderItemsJson: JSON.stringify(jsonRows),
          notes: data.notes !== undefined ? (String(data.notes || "").trim() || null) : undefined
        }
      });

      // Replace invoice/payment so the old PDF + totals are fully reset.
      if (order.invoice) {
        await tx.payment.deleteMany({ where: { invoiceId: order.invoice.id } });
        await tx.invoice.delete({ where: { id: order.invoice.id } });
      }
      const invoiceNumber = await this.nextAutoInvoiceNumberForOrder({
        id: order.id,
        createdAt: order.createdAt,
        customer: { phone: order.customer.phone }
      });
      const inv = await tx.invoice.create({
        data: { orderId, invoiceNumber, amount: subtotal }
      });
      const refreshed = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { customer: true, promoCode: true }
      });
      const pdfPath = await this.writePendingOrderInvoicePdf(
        {
          id: refreshed.id,
          subtotal: refreshed.subtotal,
          preTaxNet: refreshed.preTaxNet,
          promoDiscountPreTax: refreshed.promoDiscountPreTax,
          quantityLbs: refreshed.quantityLbs,
          productSummary: refreshed.productSummary,
          orderItemsJson: refreshed.orderItemsJson,
          notes: refreshed.notes,
          customer: refreshed.customer!,
          createdAt: refreshed.createdAt,
          promoCode: refreshed.promoCode
        },
        inv
      );
      await tx.invoice.update({ where: { id: inv.id }, data: { pdfPath } });

      return tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { customer: true, recipe: true, promoCode: true, invoice: { include: { payment: true } } }
      });
    });
  }

  async deleteOrderCascade(orderId: string) {
    await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { invoice: true }
      });
      if (!order) throw new BadRequestException("Order not found.");
      if (order.invoice) {
        await tx.payment.deleteMany({ where: { invoiceId: order.invoice.id } });
        await tx.invoice.delete({ where: { id: order.invoice.id } });
      }
      await tx.order.delete({ where: { id: orderId } });
    });
    return { deleted: true };
  }

  updateOrderProgress(data: { orderId: string; paid?: boolean; paymentMethod?: string; pickedUp?: boolean }) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.order.findUniqueOrThrow({ where: { id: data.orderId } });
      const patch: {
        paidAt?: Date | null;
        paymentStatus?: string;
        paymentMethod?: string | null;
        pickedUpAt?: Date | null;
      } = {};

      if (typeof data.paid === "boolean") {
        const nextPaidAt = data.paid ? (current.paidAt ?? new Date()) : null;
        patch.paidAt = nextPaidAt;
        patch.paymentStatus = nextPaidAt ? "PAID" : "UNPAID";
        patch.paymentMethod = nextPaidAt ? (data.paymentMethod?.trim() || current.paymentMethod || null) : null;
      } else if (typeof data.paymentMethod === "string" && data.paymentMethod.trim()) {
        patch.paymentMethod = data.paymentMethod.trim();
      }

      if (typeof data.pickedUp === "boolean") {
        patch.pickedUpAt = data.pickedUp ? (current.pickedUpAt ?? new Date()) : null;
      }

      await tx.order.update({
        where: { id: data.orderId },
        data: patch
      });

      const latest = await tx.order.findUniqueOrThrow({
        where: { id: data.orderId }
      });
      const nextStatus =
        latest.status === OrderStatus.CANCELLED
          ? OrderStatus.CANCELLED
          : (latest.paidAt && latest.pickedUpAt ? OrderStatus.FULFILLED : OrderStatus.CONFIRMED);

      return tx.order.update({
        where: { id: data.orderId },
        data: { status: nextStatus },
        include: { customer: true, invoice: { include: { payment: true } } }
      });
    });
  }

  async applyOrderPartialPayment(data: { orderId: string; amount: number; paymentMethod: string }) {
    const amount = Number(data.amount || 0);
    const method = String(data.paymentMethod || "").trim();
    if (!(amount > 0)) throw new BadRequestException("Partial payment amount must be greater than 0.");
    if (!method) throw new BadRequestException("Payment method is required for partial payment.");

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: data.orderId },
        include: { invoice: { include: { payment: true } } }
      });
      if (order.status === OrderStatus.CANCELLED) throw new BadRequestException("Cannot apply payment to a cancelled order.");

      let invoice = order.invoice;
      if (!invoice) {
        if (order.status === OrderStatus.NEW || order.status === OrderStatus.CONFIRMED) {
          await this.ensureInvoiceForPendingOrder(order.id);
          invoice = await tx.invoice.findUnique({
            where: { orderId: order.id },
            include: { payment: true }
          });
        } else {
          throw new BadRequestException("Order invoice not found.");
        }
      }
      if (!invoice) throw new BadRequestException("Order invoice not found.");

      const due = Math.max(0, Number(invoice.amount || 0));
      const alreadyPaid = Math.max(0, Number(invoice.payment?.amount || 0));
      const nextPaidAmount = Math.min(due, alreadyPaid + amount);
      const fullyPaid = nextPaidAmount >= due - 0.00001;

      await tx.payment.upsert({
        where: { invoiceId: invoice.id },
        update: {
          amount: nextPaidAmount,
          status: fullyPaid ? "PAID" : "PARTIAL",
          paidAt: new Date()
        },
        create: {
          invoiceId: invoice.id,
          amount: nextPaidAmount,
          status: fullyPaid ? "PAID" : "PARTIAL",
          paidAt: new Date()
        }
      });

      const patchStatus = fullyPaid ? "PAID" : "PARTIAL";
      const patched = await tx.order.update({
        where: { id: order.id },
        data: {
          paymentMethod: method,
          paymentStatus: patchStatus,
          paidAt: fullyPaid ? (order.paidAt ?? new Date()) : null
        }
      });

      const nextOrderStatus =
        patched.status === OrderStatus.CANCELLED
          ? OrderStatus.CANCELLED
          : (fullyPaid && patched.pickedUpAt ? OrderStatus.FULFILLED : OrderStatus.CONFIRMED);

      return tx.order.update({
        where: { id: order.id },
        data: { status: nextOrderStatus },
        include: { customer: true, invoice: { include: { payment: true } } }
      });
    });
  }

  async createInvoice(data: { orderId: string; invoiceNumber: string; amount: number }) {
    return this.prisma.invoice.create({
      data: {
        orderId: data.orderId,
        invoiceNumber: data.invoiceNumber,
        amount: data.amount
      },
      include: { order: { include: { customer: true } } }
    });
  }

  listInvoices() {
    return this.prisma.invoice.findMany({
      include: { order: { include: { customer: true } }, payment: true },
      orderBy: { createdAt: "desc" }
    });
  }

  markInvoicePaid(data: { invoiceId: string; amount: number; status?: string }) {
    return this.prisma.payment.upsert({
      where: { invoiceId: data.invoiceId },
      update: {
        amount: data.amount,
        status: data.status ?? "PAID",
        paidAt: new Date()
      },
      create: {
        invoiceId: data.invoiceId,
        amount: data.amount,
        status: data.status ?? "PAID",
        paidAt: new Date()
      }
    });
  }

  /**
   * Create invoice + PDF if missing; backfill PDF if invoice exists without pdfPath; otherwise skip.
   * Same line-item + NJ 6.625% logic as the Invoice tab.
   */
  private async applyInvoiceSyncToOrder(order: {
    id: string;
    subtotal: unknown;
    preTaxNet?: unknown | null;
    promoDiscountPreTax?: unknown | null;
    productSummary?: string | null;
    orderItemsJson?: string | null;
    notes: string | null;
    createdAt: Date;
    customer: { name: string; email: string | null; phone: string | null } | null;
    invoice: { id: string; invoiceNumber: string; pdfPath: string | null } | null;
    promoCode?: { code: string; label: string; kind: PromoKind } | null;
  }): Promise<"created" | "skipped" | "pdfRepaired"> {
    if (!order.customer) {
      throw new Error("Order is missing a customer; cannot create invoice.");
    }
    const customer = order.customer;
    const orderNarrow = { ...order, customer };
    if (order.invoice) {
      if (order.invoice.pdfPath) return "skipped";
      const pdfPath = await this.writePendingOrderInvoicePdf(orderNarrow, order.invoice);
      await this.prisma.invoice.update({ where: { id: order.invoice.id }, data: { pdfPath } });
      return "pdfRepaired";
    }
    const invoiceNumber = await this.nextAutoInvoiceNumberForOrder(orderNarrow);
    const totals = this.orderInvoiceTotals(order);
    const inv = await this.prisma.invoice.create({
      data: {
        orderId: order.id,
        invoiceNumber,
        amount: totals.total
      }
    });
    const pdfPath = await this.writePendingOrderInvoicePdf(orderNarrow, inv);
    await this.prisma.invoice.update({ where: { id: inv.id }, data: { pdfPath } });
    return "created";
  }

  /**
   * For each NEW/CONFIRMED order: create invoice + PDF if missing; backfill PDF if invoice exists without pdfPath.
   * Mirrors Invoice tab defaults: one line at order subtotal, discount 0, NJ tax 6.625%.
   */
  async syncPendingOrderInvoices() {
    const orders = await this.prisma.order.findMany({
      where: { status: { in: [OrderStatus.NEW, OrderStatus.CONFIRMED] } },
      include: { customer: true, invoice: true, promoCode: true }
    });
    return this.runInvoiceSyncBatch(orders);
  }

  /**
   * One-time / manual backfill: FULFILLED and CANCELLED archive orders get invoice + saved PDF if missing
   * (same defaults as pending sync). Skips orders that already have a PDF.
   */
  async syncArchiveOrderInvoices() {
    const orders = await this.prisma.order.findMany({
      where: { status: { in: [OrderStatus.FULFILLED, OrderStatus.CANCELLED] } },
      include: { customer: true, invoice: true, promoCode: true }
    });
    return this.runInvoiceSyncBatch(orders);
  }

  /**
   * Rebuild every invoice PDF with the current template and logo (from `Backend/Invoices/logo.png` or `INVOICE_LOGO_PATH`).
   * Rewrites files in `Backend/Invoices/` and `Invoices/archive/`. Syncs `invoice.amount` to match order subtotal + NJ tax.
   * Does not create invoices for orders that lack one — use sync-pending / sync-archive first.
   */
  async regenerateAllInvoicePdfs(): Promise<{
    updated: number;
    failed: number;
    total: number;
    invoicesDir: string;
    logoUsed: string | null;
    errors: string[];
  }> {
    const logoUsed = this.resolveInvoiceLogoAbsPath() || null;
    const invoicesDir = this.invoicesUploadDir();
    const rows = await this.prisma.invoice.findMany({
      include: { order: { include: { customer: true, promoCode: true } } },
      orderBy: { createdAt: "asc" }
    });
    const summary = {
      updated: 0,
      failed: 0,
      total: rows.length,
      invoicesDir,
      logoUsed,
      errors: [] as string[]
    };
    for (const inv of rows) {
      const order = inv.order;
      if (!order.customer) {
        summary.failed += 1;
        if (summary.errors.length < 40) {
          summary.errors.push(`Invoice ${inv.invoiceNumber}: order has no customer`);
        }
        continue;
      }
      try {
        const totals = this.orderInvoiceTotals(order);
        const pdfPath = await this.writePendingOrderInvoicePdf(
          {
            id: order.id,
            subtotal: order.subtotal,
            preTaxNet: order.preTaxNet,
            promoDiscountPreTax: order.promoDiscountPreTax,
            quantityLbs: order.quantityLbs,
            productSummary: order.productSummary,
            orderItemsJson: order.orderItemsJson,
            notes: order.notes,
            customer: order.customer,
            createdAt: order.createdAt,
            promoCode: order.promoCode
          },
          { id: inv.id, invoiceNumber: inv.invoiceNumber }
        );
        await this.prisma.invoice.update({
          where: { id: inv.id },
          data: { pdfPath, amount: totals.total }
        });
        summary.updated += 1;
      } catch (e: unknown) {
        summary.failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        if (summary.errors.length < 40) {
          summary.errors.push(`Invoice ${inv.invoiceNumber}: ${msg}`);
        }
      }
    }
    try {
      await this.ensureDemoInvoiceSample();
    } catch {
      // non-fatal
    }
    return summary;
  }

  /**
   * One shot: ensure every **pending** (NEW/CONFIRMED) and **archive** (FULFILLED/CANCELLED) order has an invoice + PDF if possible,
   * then rebuild **every** invoice PDF with the current template and logo.
   */
  async syncPendingArchiveAndRegenerateAllInvoices(): Promise<{
    pendingSync: { created: number; skipped: number; pdfRepaired: number; failed: number; errors: string[] };
    archiveSync: { created: number; skipped: number; pdfRepaired: number; failed: number; errors: string[] };
    regenerate: {
      updated: number;
      failed: number;
      total: number;
      invoicesDir: string;
      logoUsed: string | null;
      errors: string[];
    };
  }> {
    const pendingSync = await this.syncPendingOrderInvoices();
    const archiveSync = await this.syncArchiveOrderInvoices();
    const regenerate = await this.regenerateAllInvoicePdfs();
    return { pendingSync, archiveSync, regenerate };
  }

  private async runInvoiceSyncBatch(
    orders: Array<{
      id: string;
      subtotal: unknown;
      preTaxNet?: unknown | null;
      promoDiscountPreTax?: unknown | null;
      productSummary?: string | null;
      orderItemsJson?: string | null;
      notes: string | null;
      createdAt: Date;
      customer: { name: string; email: string | null; phone: string | null } | null;
      invoice: { id: string; invoiceNumber: string; pdfPath: string | null } | null;
      promoCode?: { code: string; label: string; kind: PromoKind } | null;
    }>
  ) {
    const summary = {
      created: 0,
      skipped: 0,
      pdfRepaired: 0,
      failed: 0,
      errors: [] as string[]
    };
    for (const order of orders) {
      try {
        const r = await this.applyInvoiceSyncToOrder(order);
        if (r === "created") summary.created += 1;
        else if (r === "skipped") summary.skipped += 1;
        else summary.pdfRepaired += 1;
      } catch (e: unknown) {
        summary.failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        if (summary.errors.length < 30) {
          summary.errors.push(`Order ${order.id.slice(0, 8)}…: ${msg}`);
        }
      }
    }
    return summary;
  }

  async ensureInvoiceForPendingOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true, invoice: true, promoCode: true }
    });
    if (!order) throw new BadRequestException("Order not found.");
    if (order.status !== OrderStatus.NEW && order.status !== OrderStatus.CONFIRMED) {
      throw new BadRequestException("Only pending orders can use auto-invoice here.");
    }
    if (order.invoice?.pdfPath) {
      return this.prisma.order.findUnique({
        where: { id: orderId },
        include: { customer: true, recipe: true, promoCode: true, invoice: { include: { payment: true } } }
      });
    }
    await this.applyInvoiceSyncToOrder(order);
    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { customer: true, recipe: true, promoCode: true, invoice: { include: { payment: true } } }
    });
  }

  listPromoCodes() {
    return this.prisma.promoCode.findMany({ orderBy: { createdAt: "desc" } });
  }

  async createPromoCode(data: {
    code: string;
    label: string;
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
    const label = String(data.label || "").trim();
    if (!label) throw new BadRequestException("Label / co-op name is required.");
    return this.prisma.promoCode.create({
      data: {
        code,
        label,
        kind: data.kind,
        active: data.active ?? true,
        discountPercent: data.discountPercent != null ? data.discountPercent : null,
        discountFixed: data.discountFixed != null ? data.discountFixed : null,
        kickbackPercent: data.kickbackPercent != null ? data.kickbackPercent : null,
        kickbackFixed: data.kickbackFixed != null ? data.kickbackFixed : null,
        payeeNotes: data.payeeNotes?.trim() || null
      }
    });
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
    return this.prisma.promoCode.update({
      where: { id },
      data: {
        ...(data.label !== undefined ? { label: String(data.label).trim() } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.discountPercent !== undefined ? { discountPercent: data.discountPercent } : {}),
        ...(data.discountFixed !== undefined ? { discountFixed: data.discountFixed } : {}),
        ...(data.kickbackPercent !== undefined ? { kickbackPercent: data.kickbackPercent } : {}),
        ...(data.kickbackFixed !== undefined ? { kickbackFixed: data.kickbackFixed } : {}),
        ...(data.payeeNotes !== undefined ? { payeeNotes: data.payeeNotes?.trim() || null } : {})
      }
    });
  }

  async getCoopKickbackSummary() {
    const rows = await this.prisma.order.findMany({
      where: { promoCodeId: { not: null }, promoCode: { kind: PromoKind.COOP } },
      include: { promoCode: true }
    });
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
    for (const o of rows) {
      if (!o.promoCodeId || !o.promoCode) continue;
      const cur =
        map.get(o.promoCodeId) ??
        ({
          promoCodeId: o.promoCodeId,
          code: o.promoCode.code,
          label: o.promoCode.label,
          payeeNotes: o.promoCode.payeeNotes,
          orderCount: 0,
          kickbackOwed: 0,
          revenueTaxIncl: 0
        } as Acc);
      cur.orderCount += 1;
      cur.kickbackOwed += Number(o.coOpKickbackOwed || 0);
      cur.revenueTaxIncl += Number(o.subtotal || 0);
      map.set(o.promoCodeId, cur);
    }
    return [...map.values()].sort((a, b) => b.kickbackOwed - a.kickbackOwed);
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
