/**
 * Jersey Raw single-sheet controller (Apps Script Web App).
 *
 * Spreadsheet tabs required:
 * - Expenses
 * - Pending
 * - Archive
 * - UploadsLedger  (new)
 * - Config         (new)
 * - KickbackPayments (optional until fix() / ensureSchema_; payout ledger for co-op kickbacks)
 *
 * Pending / Archive rows also store promo economics (append columns): promoCode, promoDiscountPreTax,
 * coOpKickbackOwed, preTaxNet — filled from JR_PROMO_CODES_JSON in Settings plus NJ_TAX_RATE (default 6.625%).
 * Line totals use product `price` as tax-inclusive (NJ); discounts adjust subtotalTaxIncl; kickback is stored on the row.
 *
 * Deployment:
 * 1) Extensions > Apps Script (bound to your single spreadsheet).
 * 2) Paste this file as Code.gs.
 * 3) Project Settings > Script properties:
 *    - API_KEY: random long secret (same value used by your app requests).
 *    - INVOICES_FOLDER_ID: 1eTvPeZ8tYxO06TCGrebpJFS6J6L5fAD4
 *    - RECEIPTS_FOLDER_ID: optional override; if unset, JR_RECEIPTS_FOLDER_ID below is used. Share that folder with the account that runs the web app.
 *    - UPLOADS_START_AT_ISO: 2026-03-25T00:00:00-04:00  (no backlog before this timestamp)
 * 4) Deploy as Web App (execute as you, access "Anyone with link" or restricted as you prefer).
 *    This controller serves both login and runtime actions.
 */

const TAB_EXPENSES = "Expenses";
const TAB_PENDING = "Pending";
const TAB_ARCHIVE = "Archive";
const TAB_UPLOADS_LEDGER = "UploadsLedger";
const TAB_CONFIG = "Config";
const TAB_CUSTOMERS = "Customers";
const TAB_PRODUCTS = "Products";
const TAB_INGREDIENTS = "Ingredients";
const TAB_INVENTORY = "Inventory";
const TAB_INGREDIENT_INVENTORY = "IngredientInventory";
const TAB_INVENTORY_LOG = "InventoryLog";
const TAB_PAYMENTS = "Payments";
const TAB_SETTINGS = "Settings";
const TAB_AUDIT_LOG = "AuditLog";
const TAB_WEB_LOGIN = "WebLogin";
/** Manual ledger: co-op kickback payouts (not order payments — see Payments). Hub + API read/write. */
const TAB_KICKBACK_PAYMENTS = "KickbackPayments";
/** Making + formula engine tabs (see Fix.gs). Supports multiple recipe rows at once. */
const TAB_MAKING = "Making";
const TAB_RECIPE_BOOK_AUTO = "RecipeBook_Auto";
const TAB_SHOPPING_AUTO = "Shopping_Auto";
const TAB_BATCH_PLAN_AUTO = "BatchPlan_Auto";
const TAB_MAKING_PRINT = "Making_Print";
const TAB_TOTALS_AUTO = "Totals_Auto";
/** ~4 ml per pump — matches legacy sheet math for Salmon oil row amounts */
const JR_SALMON_OIL_PUMPS_PER_LB = 113.398;
const HEADERS_MAKING = ["recipeId", "recipeName", "targetLbs", "maxBatchLbs", "batchCount", "batchPlanLbs", "notes"];
const HEADERS_RECIPE_BOOK_AUTO = [
  "recipeId",
  "recipeName",
  "ingredientName",
  "ratioPct",
  "lbsPer50Batch",
  "ingredientCostPerLb",
  "costPer50Batch"
];
const HEADERS_SHOPPING_AUTO = ["ingredientName", "neededLbs", "onHandLbs", "buyLbs"];
const HEADERS_BATCH_PLAN_AUTO = ["recipeId", "recipeName", "batchNo", "batchLbs", "ingredientName", "ingredientLbs"];
const HEADERS_MAKING_PRINT = ["recipeName", "batchLabel"];
const HEADERS_TOTALS_AUTO = ["key", "value"];
let AUDIT_SUPPRESSED = false;
const JR_PENDING_INVOICES_FOLDER_ID = "1572dz4N6RD9grkUoVSFF0rP_hVWBHVKg";
const JR_ARCHIVE_INVOICES_FOLDER_ID = "17LAoXhYG0GZiH5mlZ2VjiCfMs523gCVY";
const JR_LOGO_FOLDER_ID = "1eTvPeZ8tYxO06TCGrebpJFS6J6L5fAD4";
/** Expense receipt uploads (hub → Drive). Override with Script property RECEIPTS_FOLDER_ID if needed. */
const JR_RECEIPTS_FOLDER_ID = "1DnA91fLhXmbQoHoWx8OyKarpM8QKLjGc";
const JR_LOGO_FILE_NAME = "photo-jersey-raw-logo.jpg.jpg";
const JR_SQUARE_CHECKOUT_LINK = "https://checkout.square.site/merchant/ML7JBVQHNKGKX/checkout/PYFVIR4HXGKCJ2TPCDYNE2K3?src=sheet";
const JR_CARD_FEE_RATE = 0.033;

const HEADERS = {
  Expenses: [
    "id",
    "expenseDate",
    "vendor",
    "category",
    "amount",
    "paymentMethod",
    "notes",
    "receiptFileId",
    "receiptUrl",
    "createdAt",
    "updatedAt"
  ],
  Pending: [
    "id",
    "createdAt",
    "customerName",
    "phone",
    "email",
    "address",
    "recipe",
    "orderItemsJson",
    "quantityLbs",
    "subtotalTaxIncl",
    "status",
    "invoiceNumber",
    "invoiceFileId",
    "invoiceUrl",
    "notes",
    "updatedAt",
    "promoCode",
    "promoDiscountPreTax",
    "coOpKickbackOwed",
    "preTaxNet",
    "profit",
    "profitPerLb",
    "amountPaid",
    "balanceDue",
    "paymentStatus",
    "paidAt",
    "pickedUpAt",
    "paymentMethod"
  ],
  Archive: [
    "id",
    "createdAt",
    "completedAt",
    "customerName",
    "phone",
    "email",
    "recipe",
    "orderItemsJson",
    "quantityLbs",
    "subtotalTaxIncl",
    "status",
    "invoiceNumber",
    "invoiceFileId",
    "invoiceUrl",
    "notes",
    "updatedAt",
    "promoCode",
    "promoDiscountPreTax",
    "coOpKickbackOwed",
    "preTaxNet",
    "profit",
    "profitPerLb",
    "amountPaid",
    "balanceDue",
    "paymentStatus",
    "paidAt",
    "pickedUpAt"
  ],
  UploadsLedger: [
    "id",
    "kind",
    "sheet",
    "rowId",
    "fileName",
    "fileId",
    "url",
    "sha256",
    "createdAt"
  ],
  Customers: [
    "id",
    "name",
    "phone",
    "email",
    "address",
    "notes",
    "createdAt",
    "updatedAt"
  ],
  Products: [
    "id",
    "sku",
    "name",
    "description",
    "foodType",
    "unit",
    "chargeUnit",
    "amountPerUnit",
    "price",
    "cost",
    "isBundle",
    "costPerLb",
    "ingredientCount",
    "active",
    "snapshotAt",
    "updatedAt"
  ],
  Ingredients: [
    "id",
    "name",
    "category",
    "unit",
    "defaultCost",
    "chargePerUnit",
    "vendor",
    "usedInProducts",
    "usedInProductsCount",
    "avgRatioPercent",
    "active",
    "updatedAt"
  ],
  /** Finished-product stock (lbs or selling units). After migration, ingredient lots live on IngredientInventory. */
  Inventory: [
    "id",
    "productId",
    "productName",
    "sku",
    "unit",
    "quantityOnHand",
    "avgUnitCost",
    "notes",
    "updatedAt"
  ],
  /** Raw ingredient on-hand (for recipe / make-batch). Migrated from legacy Inventory rows. */
  IngredientInventory: [
    "id",
    "ingredientId",
    "ingredientName",
    "quantityOnHand",
    "unitCost",
    "receivedAt",
    "notes",
    "updatedAt"
  ],
  /** Append-only style log for product stock (manual adds + archive deductions). */
  InventoryLog: [
    "id",
    "at",
    "kind",
    "productId",
    "productName",
    "deltaQty",
    "quantityAfter",
    "unit",
    "orderId",
    "notes"
  ],
  Payments: [
    "id",
    "orderId",
    "invoiceNumber",
    "amount",
    "paymentMethod",
    "status",
    "paidAt",
    "notes",
    "createdAt",
    "updatedAt"
  ],
  AuditLog: [
    "id",
    "at",
    "actor",
    "action",
    "targetSheet",
    "targetId",
    "details"
  ],
  /** Web UI login: column A username, B password (plain text — restrict sheet access). Optional notes / updatedAt. */
  WebLogin: ["username", "password", "notes", "updatedAt"],
  /**
   * Kickback payouts to organizers (Zelle, etc.). Promo definitions stay in Settings JR_PROMO_CODES_JSON.
   * paidAt = when you sent money; periodFrom/periodTo = sales window you are settling (YYYY-MM-DD or ISO).
   * promoCode empty = one combined payout not tied to a single code.
   */
  KickbackPayments: [
    "id",
    "paidAt",
    "periodFrom",
    "periodTo",
    "promoCode",
    "promoLabel",
    "amountPaid",
    "notes",
    "createdAt"
  ]
};

/** Same key as the Nest API / Settings tab — JSON array of promo rows ({ code, kind, active, discountPercent, … }). */
const JR_PROMO_CODES_JSON = "JR_PROMO_CODES_JSON";

function njTaxRate_() {
  const s = settingsMap_();
  return toNum_(s.NJ_TAX_RATE || 0.06625);
}

function promoCodesList_() {
  const s = settingsMap_();
  const raw = String(s[JR_PROMO_CODES_JSON] || "").trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function findPromoByCode_(codeUpper) {
  const c = String(codeUpper || "").trim().toUpperCase();
  if (!c) return null;
  const list = promoCodesList_();
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (String(p.code || "").trim().toUpperCase() !== c) continue;
    if (p.active === false) return null;
    return p;
  }
  return null;
}

/**
 * Coupon vs co-op kind is for labeling; both can use %/$ off pre-tax and %/$ kickback on pre-tax merchandise.
 * Kickback is computed on the original pre-tax net (before customer discount).
 */
function applyPromoToPreTaxNet_(preTaxNet, promo) {
  if (!promo || !(preTaxNet > 0)) return { promoDiscountPreTax: 0, coOpKickbackOwed: 0 };
  const pct = promo.discountPercent != null ? toNum_(promo.discountPercent) : 0;
  const fix = promo.discountFixed != null ? toNum_(promo.discountFixed) : 0;
  let disc = 0;
  if (pct > 0) disc += (preTaxNet * pct) / 100;
  if (fix > 0) disc += fix;
  const promoDiscountPreTax = Math.min(preTaxNet, Math.max(0, disc));
  const kp = promo.kickbackPercent != null ? toNum_(promo.kickbackPercent) : 0;
  const kf = promo.kickbackFixed != null ? toNum_(promo.kickbackFixed) : 0;
  const coOpKickbackOwed = Math.max(0, (preTaxNet * kp) / 100 + kf);
  return { promoDiscountPreTax: promoDiscountPreTax, coOpKickbackOwed: coOpKickbackOwed };
}

/**
 * Line totals are treated as NJ tax–inclusive; preTaxNet = incl / (1+rate).
 * Any discount lowers pre-tax then recomputes subtotalTaxIncl; kickback is stored on the row for tracking.
 */
function attachPromoEconomicsToRow_(row, promoCodeRaw) {
  const taxR = njTaxRate_();
  const incl = round2_(toNum_(row.subtotalTaxIncl));
  let preTax = incl > 0 ? round2_(incl / (1 + taxR)) : 0;
  const code = String(promoCodeRaw != null ? promoCodeRaw : row.promoCode || "").trim();
  row.promoCode = code;
  const promo = code ? findPromoByCode_(code.toUpperCase()) : null;
  const ap = applyPromoToPreTaxNet_(preTax, promo);
  row.promoDiscountPreTax = ap.promoDiscountPreTax;
  row.coOpKickbackOwed = ap.coOpKickbackOwed;
  row.preTaxNet = preTax;
  if (promo && ap.promoDiscountPreTax > 0) {
    const post = Math.max(0, preTax - ap.promoDiscountPreTax);
    row.subtotalTaxIncl = round2_(post * (1 + taxR));
  }
}

/**
 * $/lb (or equivalent for COGS) from Products: prefer costPerLb; if 0/missing, use `cost` for lb products,
 * or cost ÷ amountPerUnit for bag/unit rows (formula sometimes leaves costPerLb blank).
 */
function effectiveCostPerLbForProduct_(prod) {
  if (!prod) return 0;
  let cpl = toNum_(prod.costPerLb);
  if (cpl > 0) return cpl;
  const c = toNum_(prod.cost);
  if (!(c > 0)) return 0;
  const pu = String(prod.unit || "lb").toLowerCase();
  if (pu === "lb") return c;
  const apu = Math.max(0.0001, toNum_(prod.amountPerUnit != null ? prod.amountPerUnit : 1));
  return c / apu;
}

function computeProfitFieldsForRow_(row) {
  const lines = parseOrderLinesForProfit_(row);
  const products = listAllProducts_();
  const byId = {};
  const byName = {};
  for (const p of products) {
    const pid = String(p.id || "").trim();
    const name = String(p.name || "").trim().toLowerCase();
    if (pid) byId[pid] = p;
    if (name) byName[name] = p;
  }

  let totalCost = 0;
  let qtyLbs = 0;
  for (const line of lines) {
    const pid = String(line.productId || "").trim();
    const pname = String(line.productName || "").trim().toLowerCase();
    const prod = (pid && byId[pid]) || (pname && byName[pname]) || null;
    const q = Math.max(0, toNum_(line.quantity));
    const unit = String(line.quantityUnit || "lb").toLowerCase();
    const amountPerUnit = Math.max(0.0001, toNum_(prod && prod.amountPerUnit ? prod.amountPerUnit : 1));
    const lineLbs = unit === "lb" ? q : q * amountPerUnit;
    qtyLbs += lineLbs;
    const costPerLb = Math.max(0, effectiveCostPerLbForProduct_(prod));
    totalCost += lineLbs * costPerLb;
  }

  const rowQty = Math.max(0, toNum_(row.quantityLbs));
  if (qtyLbs <= 0 && rowQty > 0) qtyLbs = rowQty;
  const preTax = Math.max(0, round2_(toNum_(row.preTaxNet)));
  const profit = round2_(preTax - totalCost);
  const profitPerLb = qtyLbs > 0 ? round2_(profit / qtyLbs) : 0;
  row.profit = profit;
  row.profitPerLb = profitPerLb;
}

function parseOrderLinesForProfit_(row) {
  const raw = String(row && row.orderItemsJson || "").trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (err) {
      // fallback below
    }
  }
  return [{
    productId: "",
    productName: String(row && row.recipe || "").trim(),
    quantity: toNum_(row && row.quantityLbs),
    quantityUnit: "lb"
  }];
}

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "health").trim();

    if (action === "loginPage") {
      return htmlWebLoginPageOutput_();
    }

    if (action === "sessionPing") {
      const tok = String((e.parameter && e.parameter.sessionToken) || "").trim();
      return json_({ ok: true, valid: webSessionIsValid_(tok) });
    }

    /**
     * Read-only financial snapshots from the Calculator tab (native Sheet formulas).
     * No tab scans — avoids the work of action=pull. Run JR_createCalculatorSheet() once.
     */
    if (action === "totals") {
      auth_(e);
      return json_({ ok: true, totals: readCalculatorTotalsObject_(), now: nowIso_() });
    }

    if (action === "customerSearch") {
      auth_(e);
      const q = e && e.parameter && e.parameter.query != null ? String(e.parameter.query) : "";
      return json_(customerSearchFromCalculator_(q));
    }

    // Do not run ensureSchema_ on every GET — Web App HTTP requests often lack a reliable active spreadsheet,
    // and pull/refresh only need to read tabs. Use POST (or run fix() in the sheet) to create/repair schema.

    if (action === "health") {
      return json_({ ok: true, service: "jr-sheet-controller", now: nowIso_() });
    }

    if (action === "pull") {
      auth_(e);
      const since = String((e.parameter && e.parameter.since) || "");
      return json_(pullSince_(since));
    }

    if (action === "summary") {
      auth_(e);
      return json_(summary_());
    }
    if (action === "settings") {
      auth_(e);
      return json_({ ok: true, settings: settingsMap_() });
    }
    if (action === "checkPages") {
      auth_(e);
      return json_(checkPages_());
    }

    if (action === "makingEngine") {
      auth_(e);
      return json_(makingEngineSnapshot_());
    }

    return json_({ ok: false, error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
  }
}

function doPost(e) {
  try {
    const payload = parsePostPayload_(e);
    const action = String(payload.action || "").trim();
    if (action === "login") {
      return handleWebLoginPayload_(payload);
    }
    if (action === "makingPlanCompute") {
      auth_(e);
      return json_(makingPlanCompute_(payload));
    }
    if (action === "replaceMaking") {
      auth_(e);
      return json_(replaceMakingFromPayload_(payload));
    }
    if (action === "refreshBatchPlan") {
      auth_(e);
      return json_(jrRefreshBatchPlanAuto_());
    }
    ensureSchema_();
    if (!(action === "submitOrder" && publicSubmitAllowed_())) {
      auth_(e);
    }

    if (action === "upsertExpense") return json_(upsertExpense_(payload));
    if (action === "upsertPending") return json_(upsertPending_(payload));
    if (action === "submitOrder") return json_(submitOrder_(payload));
    if (action === "upsertArchive") return json_(upsertArchive_(payload));
    if (action === "upsertCustomer") return json_(upsertCustomer_(payload));
    if (action === "upsertProduct") return json_(upsertProduct_(payload));
    if (action === "upsertIngredient") return json_(upsertIngredient_(payload));
    if (action === "setProductIngredients") return json_(setProductIngredients_(payload)); // backward compatible alias
    if (action === "upsertInventory") return json_(upsertInventory_(payload));
    if (action === "addInventory") return json_(addInventory_(payload));
    if (action === "upsertPayment") return json_(upsertPayment_(payload));
    if (action === "recordPayment") return json_(recordPayment_(payload));
    if (action === "appendKickbackPayment") return json_(appendKickbackPayment_(payload));
    if (action === "setSetting") return json_(setSetting_(payload));
    if (action === "movePendingToArchive") return json_(movePendingToArchive_(payload));
    if (action === "deleteOrder") return json_(deleteOrder_(payload));
    if (action === "uploadInvoice") return json_(uploadInvoice_(payload));
    if (action === "uploadReceipt") return json_(uploadReceipt_(payload));
    if (action === "uploadExpenseReceiptsBatch") return json_(uploadExpenseReceiptsBatch_(payload));
    if (action === "bulkUpsert") return json_(bulkUpsert_(payload));
    if (action === "bulkUpload") return json_(bulkUpload_(payload));
    if (action === "clearAuditLog") return json_(clearAuditLog_(payload));
    if (action === "recalcProducts") return json_(recalcProducts_(payload));
    if (action === "applyProductFormulas") return json_(applyProductFormulas_(payload));
    if (action === "recomputeOrderEconomics") {
      const id = String(payload.id || "").trim();
      const bucket = String(payload.bucket || "pending").trim().toLowerCase();
      if (!id) throw new Error("id is required");
      if (bucket === "archive") return json_(recomputeOrderEconomics_(TAB_ARCHIVE, HEADERS.Archive, id));
      return json_(recomputeOrderEconomics_(TAB_PENDING, HEADERS.Pending, id));
    }

    return json_({ ok: false, error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
  }
}

function publicSubmitAllowed_() {
  const v = String(prop_("PUBLIC_SUBMIT_ENABLED") || "true").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Extract spreadsheet id from a raw id or a full Google Sheets URL.
 */
function normalizeSpreadsheetId_(raw) {
  var s = String(raw || "").trim();
  if (!s) return "";
  var m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  if (m) return m[1];
  return s;
}

/**
 * True if value looks like a Spreadsheet (web app sometimes returns a non-null object without getSheetByName).
 */
function isSpreadsheetLike_(ss) {
  return !!(ss && typeof ss.getSheetByName === "function" && typeof ss.insertSheet === "function");
}

/**
 * Opens the hub spreadsheet. Script property JR_SPREADSHEET_ID is tried FIRST — Web App GET requests often
 * do not get a usable SpreadsheetApp.getActiveSpreadsheet() even when the project is container-bound.
 */
function getSpreadsheetForScript_() {
  var props = PropertiesService.getScriptProperties();
  var id = normalizeSpreadsheetId_(
    props.getProperty("JR_SPREADSHEET_ID") || props.getProperty("WEBLOGIN_SPREADSHEET_ID") || ""
  );
  if (id) {
    try {
      var ssOpen = SpreadsheetApp.openById(id);
      if (isSpreadsheetLike_(ssOpen)) return ssOpen;
    } catch (eOpen) {
      throw new Error(
        "JR_SPREADSHEET_ID could not be opened: " + String(eOpen && eOpen.message ? eOpen.message : eOpen)
      );
    }
  }
  var ss0 = SpreadsheetApp.getActiveSpreadsheet();
  if (isSpreadsheetLike_(ss0)) return ss0;
  throw new Error(
    "No spreadsheet for this Web App. In Apps Script: Project Settings > Script properties — add JR_SPREADSHEET_ID " +
      "with your Google Sheet id (the long id from the sheet URL, e.g. .../spreadsheets/d/THIS_PART/edit). " +
      "Redeploy the Web App after saving properties."
  );
}

/** Login only needs WebLogin — do not run full ensureSchema_ / product formulas on every sign-in. */
function ensureWebLoginTabMinimal_() {
  const ss = getSpreadsheetForScript_();
  ensureTab_(ss, TAB_WEB_LOGIN, HEADERS.WebLogin);
}

function ensureSchema_() {
  const ss = getSpreadsheetForScript_();
  ensureTab_(ss, TAB_EXPENSES, HEADERS.Expenses);
  ensureTab_(ss, TAB_PENDING, HEADERS.Pending);
  ensureTab_(ss, TAB_ARCHIVE, HEADERS.Archive);
  ensureTab_(ss, TAB_UPLOADS_LEDGER, HEADERS.UploadsLedger);
  ensureTab_(ss, TAB_CONFIG, ["key", "value"]);
  ensureTab_(ss, TAB_CUSTOMERS, HEADERS.Customers);
  ensureTab_(ss, TAB_PRODUCTS, HEADERS.Products);
  ensureTab_(ss, TAB_INGREDIENTS, HEADERS.Ingredients);
  ensureTab_(ss, TAB_INGREDIENT_INVENTORY, HEADERS.IngredientInventory);
  ensureInventorySchemaSmart_(ss);
  ensureTab_(ss, TAB_INVENTORY_LOG, HEADERS.InventoryLog);
  ensureTab_(ss, TAB_PAYMENTS, HEADERS.Payments);
  ensureTab_(ss, TAB_SETTINGS, ["key", "value", "updatedAt"]);
  ensureTab_(ss, TAB_AUDIT_LOG, HEADERS.AuditLog);
  ensureTab_(ss, TAB_WEB_LOGIN, HEADERS.WebLogin);
  ensureTab_(ss, TAB_KICKBACK_PAYMENTS, HEADERS.KickbackPayments);
  ensureProductIngredientColumns_(10);
  applyProductFormulas_({ silent: true });
}

function ensureTab_(ss, name, header) {
  if (!isSpreadsheetLike_(ss)) {
    throw new Error("ensureTab_: internal error — not a Spreadsheet (redeploy from the bound sheet or set JR_SPREADSHEET_ID).");
  }
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const hasHeader = sh.getLastRow() >= 1;
  if (!hasHeader) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
    return;
  }
  const existing = sh.getRange(1, 1, 1, Math.max(header.length, sh.getLastColumn())).getValues()[0]
    .map((v) => String(v || "").trim());
  const needs = header.some((h, i) => existing[i] !== h);
  if (needs) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
  }
}

function isLegacyInventoryLayout_() {
  const sh = getSpreadsheetForScript_().getSheetByName(TAB_INVENTORY);
  if (!sh || sh.getLastRow() < 1) return false;
  return String(sh.getRange(1, 2).getValue() || "").trim() === "ingredientId";
}

function isProductInventoryPayload_(p) {
  return Boolean(String(p.productId || "").trim() || String(p.productName || "").trim());
}

/** Until JR_FIX_migrateToProductInventory_ runs, row1 is ingredient layout — do not overwrite with product headers. */
function ensureInventorySchemaSmart_(ss) {
  const sh = ss.getSheetByName(TAB_INVENTORY);
  if (!sh || sh.getLastRow() < 1) {
    ensureTab_(ss, TAB_INVENTORY, HEADERS.Inventory);
    return;
  }
  if (isLegacyInventoryLayout_()) return;
  ensureTab_(ss, TAB_INVENTORY, HEADERS.Inventory);
}

function ensureProductIngredientColumns_(pairCount) {
  const sh = sheet_(TAB_PRODUCTS);
  const need = Math.max(0, Number(pairCount) || 0);
  if (need <= 0) return;
  const fixed = HEADERS.Products.slice();
  const headerRow = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), fixed.length)).getValues()[0]
    .map((v) => String(v || "").trim());
  const activeHeader = headerRow.slice(0, Math.max(headerRow.length, fixed.length));
  let nextCol = Math.max(activeHeader.length, fixed.length) + 1;
  for (let i = 1; i <= need; i++) {
    const nameCol = `ingredient ${i}`;
    const ratioCol = `ingredient ${i} ratio`;
    if (!activeHeader.includes(nameCol)) {
      sh.getRange(1, nextCol, 1, 1).setValues([[nameCol]]);
      nextCol++;
    }
    if (!activeHeader.includes(ratioCol)) {
      sh.getRange(1, nextCol, 1, 1).setValues([[ratioCol]]);
      nextCol++;
    }
  }
}

function colToA1_(n) {
  let s = "";
  let x = Number(n || 1);
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || "A";
}

/** Column letter from fixFindColA1FromHeader_ → 0-based index for getValues() rows. */
function a1LetterToColumnIndex_(letter) {
  var s = String(letter || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (!s) return -1;
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  return n - 1;
}

function applyFormulaForProductRow_(sh, header, rowNum) {
  const idx = {};
  for (let i = 0; i < header.length; i++) idx[header[i]] = i + 1;
  const costCol = idx.costPerLb;
  const ingredientCountCol = idx.ingredientCount;
  if (!costCol || !ingredientCountCol) return;

  const ingredientCols = [];
  const ratioCols = [];
  for (const h of header) {
    const m = /^ingredient (\d+)$/i.exec(h);
    if (!m) continue;
    const i = Number(m[1]);
    const nameCol = idx[`ingredient ${i}`];
    const ratioCol = idx[`ingredient ${i} ratio`];
    if (nameCol && ratioCol) {
      ingredientCols.push(nameCol);
      ratioCols.push(ratioCol);
    }
  }
  if (ingredientCols.length === 0) return;
  const terms = ingredientCols.map((nameCol, i) => {
    const ratioCol = ratioCols[i];
    const nameA1 = `${colToA1_(nameCol)}${rowNum}`;
    const ratioA1 = `${colToA1_(ratioCol)}${rowNum}`;
    return `IFERROR(VLOOKUP(${nameA1},Ingredients!$B:$F,4,FALSE),0)*IFERROR(${ratioA1},0)/100`;
  });
  const costFormula = `=ROUND(${terms.join("+")},4)`;
  const countRange = ingredientCols.map((c) => `${colToA1_(c)}${rowNum}`).join(",");
  const countFormula = `=COUNTA(${countRange})`;
  sh.getRange(rowNum, costCol).setFormula(costFormula);
  sh.getRange(rowNum, ingredientCountCol).setFormula(countFormula);
}

function applyProductFormulas_(p) {
  const sh = sheet_(TAB_PRODUCTS);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return { ok: true, appliedRows: 0 };
  const header = getHeaderRow_(sh);
  for (let r = 2; r <= lastRow; r++) {
    const id = String(sh.getRange(r, 1).getValue() || "").trim();
    if (!id) continue;
    applyFormulaForProductRow_(sh, header, r);
  }
  if (!Boolean(p && p.silent)) {
    writeAudit_("applyProductFormulas", TAB_PRODUCTS, "-", { appliedRows: lastRow - 1 });
  }
  return { ok: true, appliedRows: lastRow - 1 };
}

function upsertExpense_(p) {
  const row = {
    id: String(p.id || makeId_("exp")),
    expenseDate: toIsoDate_(p.expenseDate || nowIso_()),
    vendor: String(p.vendor || ""),
    category: String(p.category || "Other"),
    amount: toNum_(p.amount),
    paymentMethod: String(p.paymentMethod || ""),
    notes: String(p.notes || ""),
    receiptFileId: String(p.receiptFileId || ""),
    receiptUrl: String(p.receiptUrl || ""),
    createdAt: String(p.createdAt || nowIso_()),
    updatedAt: nowIso_()
  };
  writeById_(TAB_EXPENSES, row, HEADERS.Expenses);
  writeAudit_("upsertExpense", TAB_EXPENSES, row.id, { vendor: row.vendor, amount: row.amount });
  return { ok: true, id: row.id };
}

function upsertPending_(p) {
  const orderId = String(p.id || makeId_("ord"));
  const paymentState = computeOrderPaymentState_(orderId, toNum_(p.subtotalTaxIncl));
  const row = {
    id: orderId,
    createdAt: String(p.createdAt || nowIso_()),
    customerName: String(p.customerName || ""),
    phone: String(p.phone || ""),
    email: String(p.email || ""),
    address: String(p.address || ""),
    recipe: String(p.recipe || ""),
    orderItemsJson: String(p.orderItemsJson || ""),
    quantityLbs: toNum_(p.quantityLbs),
    subtotalTaxIncl: toNum_(p.subtotalTaxIncl),
    status: String(p.status || "PENDING"),
    invoiceNumber: String(p.invoiceNumber || ""),
    invoiceFileId: String(p.invoiceFileId || ""),
    invoiceUrl: String(p.invoiceUrl || ""),
    notes: String(p.notes || ""),
    updatedAt: nowIso_(),
    promoCode: String(p.promoCode != null ? p.promoCode : "").trim(),
    promoDiscountPreTax: 0,
    coOpKickbackOwed: 0,
    preTaxNet: 0,
    profit: 0,
    profitPerLb: 0,
    amountPaid: paymentState.amountPaid,
    balanceDue: paymentState.balanceDue,
    paymentStatus: paymentState.paymentStatus,
    paidAt: paymentState.paidAt,
    pickedUpAt: String(p.pickedUpAt || ""),
    paymentMethod: String(p.paymentMethod || "")
  };
  attachPromoEconomicsToRow_(row, row.promoCode);
  computeProfitFieldsForRow_(row);
  writeById_(TAB_PENDING, row, HEADERS.Pending);
  writeAudit_("upsertPending", TAB_PENDING, row.id, {
    customerName: row.customerName,
    subtotalTaxIncl: row.subtotalTaxIncl,
    promoCode: row.promoCode,
    coOpKickbackOwed: row.coOpKickbackOwed
  });
  return { ok: true, id: row.id };
}

function upsertArchive_(p) {
  const orderId = String(p.id || makeId_("arc"));
  const paymentState = computeOrderPaymentState_(orderId, toNum_(p.subtotalTaxIncl));
  const row = {
    id: orderId,
    createdAt: String(p.createdAt || nowIso_()),
    completedAt: String(p.completedAt || nowIso_()),
    customerName: String(p.customerName || ""),
    phone: String(p.phone || ""),
    email: String(p.email || ""),
    recipe: String(p.recipe || ""),
    orderItemsJson: String(p.orderItemsJson || ""),
    quantityLbs: toNum_(p.quantityLbs),
    subtotalTaxIncl: toNum_(p.subtotalTaxIncl),
    status: String(p.status || "FULFILLED"),
    invoiceNumber: String(p.invoiceNumber || ""),
    invoiceFileId: String(p.invoiceFileId || ""),
    invoiceUrl: String(p.invoiceUrl || ""),
    notes: String(p.notes || ""),
    updatedAt: nowIso_(),
    promoCode: String(p.promoCode != null ? p.promoCode : "").trim(),
    promoDiscountPreTax: 0,
    coOpKickbackOwed: 0,
    preTaxNet: 0,
    profit: 0,
    profitPerLb: 0,
    amountPaid: paymentState.amountPaid,
    balanceDue: paymentState.balanceDue,
    paymentStatus: paymentState.paymentStatus,
    paidAt: paymentState.paidAt,
    pickedUpAt: String(p.pickedUpAt || "")
  };
  attachPromoEconomicsToRow_(row, row.promoCode);
  computeProfitFieldsForRow_(row);
  writeById_(TAB_ARCHIVE, row, HEADERS.Archive);
  writeAudit_("upsertArchive", TAB_ARCHIVE, row.id, {
    customerName: row.customerName,
    subtotalTaxIncl: row.subtotalTaxIncl,
    promoCode: row.promoCode,
    coOpKickbackOwed: row.coOpKickbackOwed
  });
  return { ok: true, id: row.id };
}

function upsertCustomer_(p) {
  const row = {
    id: String(p.id || makeId_("cus")),
    name: String(p.name || ""),
    phone: String(p.phone || ""),
    email: String(p.email || ""),
    address: String(p.address || ""),
    notes: String(p.notes || ""),
    createdAt: String(p.createdAt || nowIso_()),
    updatedAt: nowIso_()
  };
  writeById_(TAB_CUSTOMERS, row, HEADERS.Customers);
  writeAudit_("upsertCustomer", TAB_CUSTOMERS, row.id, { name: row.name, phone: row.phone, email: row.email });
  return { ok: true, id: row.id };
}

function upsertProduct_(p) {
  const incomingIngredients = Array.isArray(p.ingredients) ? p.ingredients : [];
  const dynamicIdx = Object.keys(p || {})
    .map((k) => /^ingredient (\d+)$/i.exec(String(k || "").trim()))
    .filter(Boolean)
    .map((m) => Number(m[1]) || 0);
  const maxDynamic = dynamicIdx.length ? Math.max.apply(null, dynamicIdx) : 0;
  if (incomingIngredients.length || maxDynamic > 0) {
    ensureProductIngredientColumns_(Math.max(incomingIngredients.length, maxDynamic));
  }
  const idCand = String(p.id || "").trim();
  var prev = null;
  if (idCand) {
    var plist = listAllProducts_();
    for (var pi = 0; pi < plist.length; pi++) {
      if (String(plist[pi].id || "").trim() === idCand) {
        prev = plist[pi];
        break;
      }
    }
  }
  function has(k) {
    return Object.prototype.hasOwnProperty.call(p, k);
  }
  const row = {
    id: idCand || makeId_("prd"),
    sku: has("sku") ? String(p.sku != null ? p.sku : "") : String((prev && prev.sku) || ""),
    name: has("name") ? String(p.name != null ? p.name : "") : String((prev && prev.name) || ""),
    description: has("description") ? String(p.description != null ? p.description : "") : String((prev && prev.description) || ""),
    foodType: has("foodType") ? String(p.foodType || "Adult") : String((prev && prev.foodType) || "Adult"),
    unit: has("unit") ? String(p.unit || p.chargeUnit || "lb") : String((prev && (prev.unit || prev.chargeUnit)) || "lb"),
    chargeUnit: has("chargeUnit") ? String(p.chargeUnit || p.unit || "lb") : String((prev && (prev.chargeUnit || prev.unit)) || "lb"),
    amountPerUnit: has("amountPerUnit") ? toNum_(p.amountPerUnit || 1) : toNum_((prev && prev.amountPerUnit) || 1),
    price: has("price") ? toNum_(p.price) : toNum_(prev && prev.price),
    cost: has("cost") ? toNum_(p.cost) : toNum_(prev && prev.cost),
    isBundle: has("isBundle") ? String(p.isBundle == null ? "false" : p.isBundle) : String((prev && prev.isBundle) || "false"),
    costPerLb: has("costPerLb")
      ? toNum_(p.costPerLb != null ? p.costPerLb : p.cost)
      : toNum_((prev && (prev.costPerLb != null ? prev.costPerLb : prev.cost)) || 0),
    ingredientCount: has("ingredientCount") ? toNum_(p.ingredientCount) : toNum_((prev && prev.ingredientCount) || 0),
    active: has("active") ? String(p.active == null ? "true" : p.active) : String((prev && prev.active) != null ? prev.active : "true"),
    snapshotAt: has("snapshotAt") ? String(p.snapshotAt || nowIso_()) : String((prev && prev.snapshotAt) || nowIso_()),
    updatedAt: nowIso_()
  };
  writeById_(TAB_PRODUCTS, row, HEADERS.Products, p);
  if (incomingIngredients.length) {
    patchProductIngredientPairsById_(row.id, incomingIngredients);
  }
  recalcSingleProduct_(row.id);
  writeAudit_("upsertProduct", TAB_PRODUCTS, row.id, {
    sku: row.sku,
    name: row.name,
    foodType: row.foodType,
    chargeUnit: row.chargeUnit,
    amountPerUnit: row.amountPerUnit,
    price: row.price,
    ingredientCount: row.ingredientCount
  });
  return { ok: true, id: row.id };
}

function upsertIngredient_(p) {
  const row = {
    id: String(p.id || makeId_("ing")),
    name: String(p.name || ""),
    category: String(p.category || "Uncategorized"),
    unit: String(p.unit || "lb"),
    defaultCost: toNum_(p.defaultCost),
    chargePerUnit: toNum_(p.chargePerUnit),
    vendor: String(p.vendor || ""),
    usedInProducts: String(p.usedInProducts || ""),
    usedInProductsCount: toNum_(p.usedInProductsCount),
    avgRatioPercent: toNum_(p.avgRatioPercent),
    active: String(p.active == null ? "true" : p.active),
    updatedAt: nowIso_()
  };
  writeById_(TAB_INGREDIENTS, row, HEADERS.Ingredients);
  writeAudit_("upsertIngredient", TAB_INGREDIENTS, row.id, {
    name: row.name,
    defaultCost: row.defaultCost,
    chargePerUnit: row.chargePerUnit
  });
  return { ok: true, id: row.id };
}

function setProductIngredients_(p) {
  const productId = String(p.productId || "").trim();
  if (!productId) throw new Error("productId is required");
  const linesRaw = Array.isArray(p.lines) ? p.lines : [];
  const lines = linesRaw
    .map((ln) => ({
      ingredientName: String(ln.ingredientName || "").trim(),
      ratioPercent: toNum_(ln.ratioPercent)
    }))
    .filter((x) => x.ingredientName && x.ratioPercent > 0);
  ensureProductIngredientColumns_(lines.length);
  patchProductIngredientPairsById_(productId, lines);
  recalcSingleProduct_(productId);
  refreshIngredientUsageSummary_();
  writeAudit_("setProductIngredients", TAB_PRODUCTS, productId, { inserted: lines.length });
  return { ok: true, productId, inserted: lines.length };
}

function refreshIngredientUsageSummary_() {
  const usage = {};
  const products = listAllProducts_();
  for (const row of products) {
    const pairs = productIngredientPairsFromRow_(row);
    for (const pair of pairs) {
      const ingId = findIngredientIdByName_(pair.name);
      if (!ingId) continue;
      if (!usage[ingId]) usage[ingId] = { products: new Set(), ratioSum: 0, cnt: 0 };
      usage[ingId].products.add(String(row.name || "").trim());
      usage[ingId].ratioSum += toNum_(pair.ratio);
      usage[ingId].cnt += 1;
    }
  }
  const ingredients = listAll_(TAB_INGREDIENTS, HEADERS.Ingredients);
  for (const ing of ingredients) {
    const u = usage[String(ing.id || "")] || { products: new Set(), ratioSum: 0, cnt: 0 };
    patchRowFieldsById_(TAB_INGREDIENTS, HEADERS.Ingredients, ing.id, {
      usedInProducts: [...u.products].filter(Boolean).join(" | "),
      usedInProductsCount: u.products.size,
      avgRatioPercent: u.cnt > 0 ? round2_(u.ratioSum / u.cnt) : 0,
      updatedAt: nowIso_()
    });
  }
}

function checkPages_() {
  const checks = [];
  const ss = getSpreadsheetForScript_();
  const required = [
    [TAB_EXPENSES, HEADERS.Expenses],
    [TAB_PENDING, HEADERS.Pending],
    [TAB_ARCHIVE, HEADERS.Archive],
    [TAB_CUSTOMERS, HEADERS.Customers],
    [TAB_PRODUCTS, HEADERS.Products],
    [TAB_INGREDIENTS, HEADERS.Ingredients],
    [TAB_INGREDIENT_INVENTORY, HEADERS.IngredientInventory],
    [TAB_INVENTORY_LOG, HEADERS.InventoryLog],
    [TAB_PAYMENTS, HEADERS.Payments],
    [TAB_SETTINGS, ["key", "value", "updatedAt"]],
    [TAB_AUDIT_LOG, HEADERS.AuditLog],
    [TAB_WEB_LOGIN, HEADERS.WebLogin],
    [TAB_KICKBACK_PAYMENTS, HEADERS.KickbackPayments]
  ];
  for (const [name, header] of required) {
    const sh = ss.getSheetByName(name);
    if (!sh) {
      checks.push({ sheet: name, ok: false, issue: "missing" });
      continue;
    }
    const existing = sh.getRange(1, 1, 1, Math.max(header.length, sh.getLastColumn())).getValues()[0]
      .map((v) => String(v || "").trim());
    const missingCols = header.filter((h, i) => existing[i] !== h);
    checks.push({ sheet: name, ok: missingCols.length === 0, issue: missingCols.length ? `header mismatch: ${missingCols.join(", ")}` : "" });
  }
  {
    const name = TAB_INVENTORY;
    const sh = ss.getSheetByName(name);
    if (!sh) {
      checks.push({ sheet: name, ok: false, issue: "missing" });
    } else if (isLegacyInventoryLayout_()) {
      const header = HEADERS.IngredientInventory;
      const existing = sh.getRange(1, 1, 1, Math.max(header.length, sh.getLastColumn())).getValues()[0]
        .map((v) => String(v || "").trim());
      const missingCols = header.filter((h, i) => existing[i] !== h);
      checks.push({
        sheet: name,
        ok: missingCols.length === 0,
        issue:
          missingCols.length > 0
            ? `legacy ingredient Inventory: ${missingCols.join(", ")}`
            : "legacy ingredient layout — migrate to product stock when ready"
      });
    } else {
      const header = HEADERS.Inventory;
      const existing = sh.getRange(1, 1, 1, Math.max(header.length, sh.getLastColumn())).getValues()[0]
        .map((v) => String(v || "").trim());
      const missingCols = header.filter((h, i) => existing[i] !== h);
      checks.push({ sheet: name, ok: missingCols.length === 0, issue: missingCols.length ? `header mismatch: ${missingCols.join(", ")}` : "" });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

function upsertInventory_(p) {
  if (isProductInventoryPayload_(p)) {
    if (isLegacyInventoryLayout_()) {
      throw new Error("Inventory tab is still ingredient-based. Run JR_FIX_migrateToProductInventory_() from Fix.gs.");
    }
    const row = {
      id: String(p.id || makeId_("pinv")),
      productId: String(p.productId || ""),
      productName: String(p.productName || ""),
      sku: String(p.sku || ""),
      unit: String(p.unit || "lb"),
      quantityOnHand: toNum_(p.quantityOnHand),
      avgUnitCost: toNum_(p.avgUnitCost || p.unitCost || 0),
      notes: String(p.notes || ""),
      updatedAt: nowIso_()
    };
    writeById_(TAB_INVENTORY, row, HEADERS.Inventory);
    writeAudit_("upsertInventoryProduct", TAB_INVENTORY, row.id, { productId: row.productId, quantityOnHand: row.quantityOnHand });
    return { ok: true, id: row.id };
  }
  const ingTab = isLegacyInventoryLayout_() ? TAB_INVENTORY : TAB_INGREDIENT_INVENTORY;
  const row = {
    id: String(p.id || makeId_("inv")),
    ingredientId: String(p.ingredientId || ""),
    ingredientName: String(p.ingredientName || ""),
    quantityOnHand: toNum_(p.quantityOnHand),
    unitCost: toNum_(p.unitCost || p.avgUnitCost || 0),
    receivedAt: String(p.receivedAt || nowIso_()),
    notes: String(p.notes || ""),
    updatedAt: nowIso_()
  };
  writeById_(ingTab, row, HEADERS.IngredientInventory);
  writeAudit_("upsertInventoryIngredient", ingTab, row.id, { ingredientId: row.ingredientId, quantityOnHand: row.quantityOnHand });
  return { ok: true, id: row.id };
}

function addProductInventory_(p) {
  const productId = String(p.productId || "").trim();
  const productName = String(p.productName || "").trim();
  if (!productId && !productName) throw new Error("productId or productName is required");
  const deltaQty = toNum_(p.addQuantity);
  const notes = String(p.notes || "");
  const rows = listAll_(TAB_INVENTORY, HEADERS.Inventory);
  let found = null;
  for (const row of rows) {
    const idMatch = productId && String(row.productId || "").trim() === productId;
    const nameMatch =
      productName && String(row.productName || "").trim().toLowerCase() === productName.toLowerCase();
    if (idMatch || nameMatch) {
      found = row;
      break;
    }
  }
  const costHint = toNum_(p.unitCost || p.avgUnitCost || 0);

  if (found) {
    const nextQty = round2_(toNum_(found.quantityOnHand) + deltaQty);
    const unit = String(found.unit || p.unit || "lb");
    patchRowFieldsById_(TAB_INVENTORY, HEADERS.Inventory, found.id, {
      quantityOnHand: nextQty,
      avgUnitCost: costHint > 0 ? costHint : toNum_(found.avgUnitCost),
      notes: notes || String(found.notes || ""),
      updatedAt: nowIso_()
    });
    appendInventoryLog_({
      kind: "ADD",
      productId: String(found.productId || ""),
      productName: String(found.productName || ""),
      deltaQty: deltaQty,
      quantityAfter: nextQty,
      unit: unit,
      orderId: "",
      notes: notes || "addInventory"
    });
    writeAudit_("addInventoryProduct", TAB_INVENTORY, found.id, { addQuantity: deltaQty, quantityOnHand: nextQty });
    return { ok: true, id: found.id, quantityOnHand: nextQty };
  }

  const prods = listAllProducts_();
  let prodRow = null;
  if (productId) {
    prodRow = prods.find((x) => String(x.id || "").trim() === productId) || null;
  }
  if (!prodRow && productName) {
    const low = productName.toLowerCase();
    prodRow = prods.find((x) => String(x.name || "").trim().toLowerCase() === low) || null;
  }
  const row = {
    id: String(p.id || makeId_("pinv")),
    productId: productId || String((prodRow && prodRow.id) || ""),
    productName: productName || String((prodRow && prodRow.name) || ""),
    sku: String((prodRow && prodRow.sku) || p.sku || ""),
    unit: String(p.unit || (prodRow && prodRow.unit) || "lb"),
    quantityOnHand: round2_(deltaQty),
    avgUnitCost: costHint > 0 ? costHint : toNum_((prodRow && prodRow.costPerLb) || 0),
    notes: notes,
    updatedAt: nowIso_()
  };
  if (!row.productId && !row.productName) {
    throw new Error("Unknown product — ensure it exists on the Products tab or pass productId.");
  }
  writeById_(TAB_INVENTORY, row, HEADERS.Inventory);
  appendInventoryLog_({
    kind: "ADD",
    productId: row.productId,
    productName: row.productName,
    deltaQty: deltaQty,
    quantityAfter: row.quantityOnHand,
    unit: row.unit,
    orderId: "",
    notes: notes || "addInventory new row"
  });
  writeAudit_("addInventoryProduct", TAB_INVENTORY, row.id, { addQuantity: deltaQty, quantityOnHand: row.quantityOnHand });
  return { ok: true, id: row.id, quantityOnHand: row.quantityOnHand };
}

function addInventory_(p) {
  if (isProductInventoryPayload_(p)) {
    if (isLegacyInventoryLayout_()) {
      throw new Error("Run JR_FIX_migrateToProductInventory_() from Fix.gs before adding product stock.");
    }
    return addProductInventory_(p);
  }
  const ingredientId = String(p.ingredientId || "").trim();
  const ingredientName = String(p.ingredientName || "").trim();
  if (!ingredientId && !ingredientName) throw new Error("ingredientId or ingredientName is required for ingredient stock");
  const deltaQty = toNum_(p.addQuantity);
  const unitCost = toNum_(p.unitCost);
  const notes = String(p.notes || "");

  const ingTab = isLegacyInventoryLayout_() ? TAB_INVENTORY : TAB_INGREDIENT_INVENTORY;
  const ingHdr = HEADERS.IngredientInventory;
  const rows = listAll_(ingTab, ingHdr);
  let found = null;
  for (const row of rows) {
    const idMatch = ingredientId && String(row.ingredientId || "").trim() === ingredientId;
    const nameMatch = ingredientName && String(row.ingredientName || "").trim().toLowerCase() === ingredientName.toLowerCase();
    if (idMatch || nameMatch) {
      found = row;
      break;
    }
  }

  if (found) {
    const nextQty = round2_(toNum_(found.quantityOnHand) + deltaQty);
    patchRowFieldsById_(ingTab, ingHdr, found.id, {
      quantityOnHand: nextQty,
      unitCost: unitCost > 0 ? unitCost : toNum_(found.unitCost),
      receivedAt: String(p.receivedAt || nowIso_()),
      notes: notes || String(found.notes || ""),
      updatedAt: nowIso_()
    });
    writeAudit_("addInventoryIngredient", ingTab, found.id, { addQuantity: deltaQty, quantityOnHand: nextQty });
    return { ok: true, id: found.id, quantityOnHand: nextQty };
  }

  const row = {
    id: String(p.id || makeId_("inv")),
    ingredientId,
    ingredientName,
    quantityOnHand: round2_(deltaQty),
    unitCost,
    receivedAt: String(p.receivedAt || nowIso_()),
    notes,
    updatedAt: nowIso_()
  };
  writeById_(ingTab, row, ingHdr);
  writeAudit_("addInventoryIngredient", ingTab, row.id, { addQuantity: deltaQty, quantityOnHand: row.quantityOnHand });
  return { ok: true, id: row.id, quantityOnHand: row.quantityOnHand };
}

function appendInventoryLog_(o) {
  const row = {
    id: makeId_("invlog"),
    at: nowIso_(),
    kind: String(o.kind || ""),
    productId: String(o.productId || ""),
    productName: String(o.productName || ""),
    deltaQty: round2_(toNum_(o.deltaQty)),
    quantityAfter: round2_(toNum_(o.quantityAfter)),
    unit: String(o.unit || ""),
    orderId: String(o.orderId || ""),
    notes: String(o.notes || "")
  };
  writeById_(TAB_INVENTORY_LOG, row, HEADERS.InventoryLog);
}

function orderLineToProductStockDeduction_(product, line) {
  const qty = Math.max(0, toNum_(line.quantity));
  const lineUnit = String(line.quantityUnit || product.unit || "lb").toLowerCase();
  const stockUnit = String(product.unit || "lb").toLowerCase();
  const amtPer = Math.max(0.0001, toNum_(product.amountPerUnit || 1));
  if (stockUnit === "lb") {
    const lbs = lineUnit === "lb" ? qty : qty * amtPer;
    return { deduct: round2_(lbs), unit: "lb" };
  }
  const units = lineUnit === "lb" ? qty / amtPer : qty;
  return { deduct: round2_(units), unit: "unit" };
}

function upsertPayment_(p) {
  const row = {
    id: String(p.id || makeId_("pay")),
    orderId: String(p.orderId || ""),
    invoiceNumber: String(p.invoiceNumber || ""),
    amount: toNum_(p.amount),
    paymentMethod: String(p.paymentMethod || ""),
    status: String(p.status || "PAID"),
    paidAt: String(p.paidAt || nowIso_()),
    notes: String(p.notes || ""),
    createdAt: String(p.createdAt || nowIso_()),
    updatedAt: nowIso_()
  };
  writeById_(TAB_PAYMENTS, row, HEADERS.Payments);
  syncOrderPaymentFields_(row.orderId);
  writeAudit_("upsertPayment", TAB_PAYMENTS, row.id, { orderId: row.orderId, amount: row.amount, status: row.status });
  return { ok: true, id: row.id };
}

function recordPayment_(p) {
  const amount = toNum_(p.amount);
  if (!(amount > 0)) throw new Error("amount must be greater than 0");
  const payment = {
    id: String(p.id || makeId_("pay")),
    orderId: String(p.orderId || ""),
    invoiceNumber: String(p.invoiceNumber || ""),
    amount,
    paymentMethod: String(p.paymentMethod || "Unknown"),
    status: String(p.status || "PAID"),
    paidAt: String(p.paidAt || nowIso_()),
    notes: String(p.notes || ""),
    createdAt: String(p.createdAt || nowIso_()),
    updatedAt: nowIso_()
  };
  writeById_(TAB_PAYMENTS, payment, HEADERS.Payments);
  syncOrderPaymentFields_(payment.orderId);
  writeAudit_("recordPayment", TAB_PAYMENTS, payment.id, {
    orderId: payment.orderId,
    invoiceNumber: payment.invoiceNumber,
    amount: payment.amount,
    paymentMethod: payment.paymentMethod
  });
  return { ok: true, id: payment.id };
}

/**
 * Log a payout to a co-op organizer (separate from square order Payments).
 * periodFrom / periodTo = sales period you are settling (any parseable date string).
 */
function appendKickbackPayment_(p) {
  const periodFrom = String(p.periodFrom || "").trim();
  const periodTo = String(p.periodTo || "").trim();
  if (!periodFrom || !periodTo) throw new Error("periodFrom and periodTo are required.");
  const amountPaid = toNum_(p.amountPaid);
  if (!(amountPaid > 0)) throw new Error("amountPaid must be greater than 0.");
  const codeRaw = String(p.promoCode || "").trim();
  const promoCode = codeRaw ? codeRaw.toUpperCase() : "";
  const promoLabel = String(p.promoLabel || "").trim();
  const notes = String(p.notes || "").trim();
  const paidAt = String(p.paidAt || "").trim() || nowIso_();
  const id = String(p.id || "").trim() || Utilities.getUuid();
  const createdAt = nowIso_();
  const row = {
    id,
    paidAt,
    periodFrom,
    periodTo,
    promoCode,
    promoLabel,
    amountPaid,
    notes,
    createdAt
  };
  writeById_(TAB_KICKBACK_PAYMENTS, row, HEADERS.KickbackPayments);
  writeAudit_("appendKickbackPayment", TAB_KICKBACK_PAYMENTS, id, {
    amountPaid,
    promoCode,
    periodFrom,
    periodTo
  });
  return { ok: true, row };
}

function setSetting_(p) {
  const key = String(p.key || "").trim();
  if (!key) throw new Error("key is required");
  const val = String(p.value == null ? "" : p.value);
  const sh = sheet_(TAB_SETTINGS);
  const values = sh.getDataRange().getValues();
  let found = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || "").trim() === key) {
      found = i + 1;
      break;
    }
  }
  if (found > 0) sh.getRange(found, 1, 1, 3).setValues([[key, val, nowIso_()]]);
  else sh.appendRow([key, val, nowIso_()]);
  writeAudit_("setSetting", TAB_SETTINGS, key, { value: val });
  return { ok: true, key, value: val };
}

function splitBatchesMax_(totalLbs, maxBatchLbs) {
  var total = toNum_(totalLbs);
  var maxB = Math.max(1, toNum_(maxBatchLbs) || 50);
  if (total <= 0) return [];
  if (total <= maxB) return [round2_(total)];
  var count = Math.ceil(total / maxB);
  var base = total / count;
  var out = [];
  var used = 0;
  for (var i = 0; i < count - 1; i++) {
    var v = round2_(base);
    out.push(v);
    used += v;
  }
  out.push(round2_(Math.max(0, total - used)));
  return out;
}

function inventoryQtyByIngredientName_() {
  var inv = isLegacyInventoryLayout_()
    ? listAll_(TAB_INVENTORY, HEADERS.IngredientInventory)
    : listAll_(TAB_INVENTORY, HEADERS.Inventory);
  var byName = {};
  for (var i = 0; i < inv.length; i++) {
    var n = String(inv[i].ingredientName || inv[i].ingredient || "").trim().toLowerCase();
    if (!n) continue;
    byName[n] = toNum_(byName[n]) + toNum_(inv[i].quantityOnHand || inv[i].quantityLbs);
  }
  var lots = listAll_(TAB_INGREDIENT_INVENTORY, HEADERS.IngredientInventory);
  for (var j = 0; j < lots.length; j++) {
    var n2 = String(lots[j].ingredientName || "").trim().toLowerCase();
    if (!n2) continue;
    byName[n2] = toNum_(byName[n2]) + toNum_(lots[j].quantityOnHand || lots[j].quantityLbs);
  }
  return byName;
}

/** Max-weight chunks (e.g. 50+50+30) — matches Fix.gs batch splitter. */
function splitToMaxChunks_(totalLbs, maxBatchLbs) {
  var total = Number(totalLbs || 0);
  var maxB = Math.max(1, Number(maxBatchLbs || 50));
  if (!(total > 0)) return [];
  var out = [];
  var left = total;
  while (left > 0) {
    var take = Math.min(maxB, left);
    out.push(Number(take.toFixed(4)));
    left = Number((left - take).toFixed(4));
  }
  return out;
}

function listAllRows_(tabName, header, skipIfEmptyKey) {
  var ss = getSpreadsheetForScript_();
  var sh = ss.getSheetByName(tabName);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];
  var key = skipIfEmptyKey || "id";
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = {};
    for (var c = 0; c < header.length; c++) row[header[c]] = c < values[r].length ? values[r][c] : "";
    if (!String(row[key] || "").trim()) continue;
    out.push(row);
  }
  return out;
}

function totalsAutoAsMap_(rows) {
  var o = {};
  for (var i = 0; i < rows.length; i++) o[String(rows[i].key || "")] = rows[i].value;
  return o;
}

function makingEngineSnapshot_() {
  return {
    ok: true,
    now: nowIso_(),
    making: listAllRows_(TAB_MAKING, HEADERS_MAKING, "recipeId"),
    recipeBookAuto: listAllRows_(TAB_RECIPE_BOOK_AUTO, HEADERS_RECIPE_BOOK_AUTO, "recipeId"),
    shoppingAuto: listAllRows_(TAB_SHOPPING_AUTO, HEADERS_SHOPPING_AUTO, "ingredientName"),
    batchPlanAuto: listAllRows_(TAB_BATCH_PLAN_AUTO, HEADERS_BATCH_PLAN_AUTO, "recipeId"),
    totalsAuto: totalsAutoAsMap_(listAllRows_(TAB_TOTALS_AUTO, HEADERS_TOTALS_AUTO, "key"))
  };
}

function applyMakingDerivedFormulas_(sh, startRow, endRow) {
  if (endRow < startRow) return;
  for (var r = startRow; r <= endRow; r++) {
    sh.getRange(r, 2).setFormula('=IF(A' + r + '="","",IFERROR(VLOOKUP(A' + r + ',Products!A:B,2,FALSE),""))');
  }
  sh.getRange(startRow, 5, endRow, 5).setFormulaR1C1('=IF(OR(RC[-2]="",RC[-1]=""),"",CEILING(RC[-2]/RC[-1],1))');
  sh.getRange(startRow, 6, endRow, 6).setFormulaR1C1(
    '=IF(RC[-1]="","",IF(RC[-1]=1,TEXT(RC[-3],"0.##"),TEXT(RC[-2],"0.##")&" x "&TEXT(RC[-1]-1,"0")&" + "&TEXT(RC[-3]-RC[-2]*(RC[-1]-1),"0.##")))'
  );
}

function jrIsSalmonOilIngredient_(name) {
  var n = String(name || "").toLowerCase();
  return n.indexOf("salmon") >= 0 && n.indexOf("oil") >= 0;
}

/** Printable qty: lbs to 2 decimals, or pumps for salmon oil (legacy sheet). */
function jrFormatIngredientQtyForPrint_(ingredientName, lbsNumeric) {
  var w = Number(lbsNumeric || 0);
  if (jrIsSalmonOilIngredient_(ingredientName)) {
    return String(Math.round(w * JR_SALMON_OIL_PUMPS_PER_LB)) + " pumps";
  }
  return w.toFixed(2);
}

/**
 * Horizontal "recipe book" layout: one row per batch, alternating ingredient / qty columns.
 * Matches legacy Create-sheet style (no date/phone columns).
 */
function jrRefreshMakingPrint_(batchRows) {
  var ss = getSpreadsheetForScript_();
  var sh = ss.getSheetByName(TAB_MAKING_PRINT);
  if (!sh) return { ok: false, skipped: true, message: "Making_Print tab missing; run fix() once." };

  var lr = sh.getLastRow();
  var lc = Math.max(40, sh.getLastColumn());
  if (lr > 1) sh.getRange(2, 1, lr, lc).clearContent();
  sh.getRange(1, 1, 1, 2).setValues([["Recipe", "Batch / size"]]);

  if (!batchRows || !batchRows.length) return { ok: true, printRows: 0 };

  var keysOrder = [];
  var map = {};
  for (var i = 0; i < batchRows.length; i++) {
    var br = batchRows[i];
    var recipeId = String(br[0] || "").trim();
    var rname = String(br[1] || "").trim();
    var bno = Number(br[2] || 0);
    var blbs = Number(br[3] || 0);
    var ing = String(br[4] || "").trim();
    var ilbs = Number(br[5] || 0);
    if (!recipeId || !ing || !(ilbs > 1e-12)) continue;
    var k = recipeId + "\t" + bno;
    if (!map[k]) {
      map[k] = { recipeId: recipeId, recipeName: rname, batchNo: bno, batchLbs: blbs, pairs: [] };
      keysOrder.push(k);
    }
    map[k].pairs.push({ name: ing, lbs: ilbs });
  }

  var nbByRid = {};
  for (var j = 0; j < keysOrder.length; j++) {
    var rid0 = keysOrder[j].split("\t")[0];
    nbByRid[rid0] = (nbByRid[rid0] || 0) + 1;
  }

  var matrix = [];
  var prevRid = null;
  for (var j2 = 0; j2 < keysOrder.length; j2++) {
    var ent = map[keysOrder[j2]];
    var rid1 = ent.recipeId;
    if (prevRid !== null && rid1 !== prevRid) matrix.push([]);
    prevRid = rid1;

    var batchLbs = Number(ent.batchLbs || 0);
    var label =
      (nbByRid[rid1] || 0) <= 1 ? batchLbs.toFixed(2) + " lbs" : "Batch " + ent.batchNo + " – " + batchLbs.toFixed(2) + " lbs";

    var row = [ent.recipeName || "", label];
    for (var p = 0; p < ent.pairs.length; p++) {
      row.push(ent.pairs[p].name);
      row.push(jrFormatIngredientQtyForPrint_(ent.pairs[p].name, ent.pairs[p].lbs));
    }
    matrix.push(row);
  }

  var maxC = 2;
  for (var m = 0; m < matrix.length; m++) {
    var row0 = matrix[m];
    var len0 = row0 && typeof row0.length === "number" ? row0.length : 0;
    if (len0 > maxC) maxC = len0;
  }
  if (!(maxC > 0) || maxC !== maxC) maxC = 2; // NaN / non-positive guard

  var grid = [];
  for (var g = 0; g < matrix.length; g++) {
    var src = matrix[g];
    var outRow = [];
    var srcLen = src && typeof src.length === "number" ? src.length : 0;
    for (var c = 0; c < maxC; c++) {
      outRow.push(c < srcLen ? src[c] : "");
    }
    grid.push(outRow);
  }

  if (grid.length) sh.getRange(2, 1, grid.length, maxC).setValues(grid);
  return { ok: true, printRows: grid.length };
}

function jrRefreshBatchPlanAuto_() {
  var ss = getSpreadsheetForScript_();
  var making = ss.getSheetByName(TAB_MAKING);
  var recipe = ss.getSheetByName(TAB_RECIPE_BOOK_AUTO);
  var out = ss.getSheetByName(TAB_BATCH_PLAN_AUTO);
  if (!making || !recipe || !out) return { ok: false, error: "Missing Making, RecipeBook_Auto, or BatchPlan_Auto (run fix() once)." };

  var lrOut = out.getLastRow();
  var lcOut = Math.max(6, out.getLastColumn());
  if (lrOut > 1) out.getRange(2, 1, lrOut, lcOut).clearContent();

  var mkLast = making.getLastRow();
  var rpLast = recipe.getLastRow();
  if (mkLast < 2 || rpLast < 2) {
    jrRefreshMakingPrint_([]);
    return { ok: true, rows: 0, message: "No making or recipe rows." };
  }

  var mk = making.getRange(2, 1, mkLast, 7).getValues();
  var rb = recipe.getRange(2, 1, rpLast, 7).getValues();

  var rbByRecipe = {};
  for (var i = 0; i < rb.length; i++) {
    var rid = String(rb[i][0] || "").trim();
    if (!rid) continue;
    if (!rbByRecipe[rid]) rbByRecipe[rid] = [];
    rbByRecipe[rid].push({
      recipeName: String(rb[i][1] || "").trim(),
      ingredientName: String(rb[i][2] || "").trim(),
      ratioPct: Number(rb[i][3] || 0)
    });
  }

  var rows = [];
  for (var j = 0; j < mk.length; j++) {
    var recipeId = String(mk[j][0] || "").trim();
    var recipeName = String(mk[j][1] || "").trim();
    var target = Number(mk[j][2] || 0);
    var maxBatch = Math.max(1, Number(mk[j][3] || 50));
    if (!recipeId || !(target > 0)) continue;
    var lines = rbByRecipe[recipeId] || [];
    if (!lines.length) continue;

    var totalRatio = 0;
    for (var t = 0; t < lines.length; t++) {
      totalRatio += Number(lines[t].ratioPct || 0);
    }
    if (!(totalRatio > 0)) continue;

    var batches = splitToMaxChunks_(target, maxBatch);
    for (var b = 0; b < batches.length; b++) {
      var batchNo = b + 1;
      var batchLbs = batches[b];
      for (var l = 0; l < lines.length; l++) {
        var ingName = lines[l].ingredientName;
        var ratio = Number(lines[l].ratioPct || 0);
        if (!ingName || !(ratio > 0)) continue;
        var share = ratio / totalRatio;
        var ingLbs = share * batchLbs;
        if (!(ingLbs > 1e-12)) continue;
        rows.push([
          recipeId,
          recipeName || lines[l].recipeName,
          batchNo,
          Number(batchLbs.toFixed(4)),
          ingName,
          Number(ingLbs.toFixed(4))
        ]);
      }
    }
  }

  if (rows.length) out.getRange(2, 1, rows.length, 6).setValues(rows);
  var pr = jrRefreshMakingPrint_(rows);
  return { ok: true, rows: rows.length, makingPrint: pr };
}

/**
 * Writes Making!A/G from API payload (multiple recipes, different lbs each), reapplies B/E/F formulas, refreshes BatchPlan_Auto.
 * Lines: { recipeId, targetLbs | amountLbs, maxBatchLbs?, notes? }
 */
function replaceMakingFromPayload_(p) {
  var ss = getSpreadsheetForScript_();
  var sh = ss.getSheetByName(TAB_MAKING);
  if (!sh) throw new Error("Making tab missing. Run fix() once in Apps Script.");

  var lines = Array.isArray(p && p.lines) ? p.lines : [];
  var maxDefault = Math.max(1, toNum_(p && p.maxBatchLbs) || 50);
  var globalNotes = String((p && p.notes) || "");
  var lastSlotRow = Math.max(sh.getLastRow(), 301);
  sh.getRange(2, 1, lastSlotRow, 7).clearContent();

  var rowIdx = 2;
  for (var i = 0; i < lines.length; i++) {
    var rid = String(lines[i] && lines[i].recipeId || "").trim();
    var lbs = toNum_(lines[i] && (lines[i].targetLbs != null ? lines[i].targetLbs : lines[i].amountLbs));
    var rowNotes = String(lines[i] && lines[i].notes != null ? lines[i].notes : "");
    var maxB = Math.max(1, toNum_(lines[i] && lines[i].maxBatchLbs) || maxDefault);
    if (!rid || !(lbs > 0)) continue;
    sh.getRange(rowIdx, 1).setValue(rid);
    sh.getRange(rowIdx, 3).setValue(lbs);
    sh.getRange(rowIdx, 4).setValue(maxB);
    sh.getRange(rowIdx, 7).setValue(rowNotes || (i === 0 ? globalNotes : ""));
    rowIdx++;
  }
  if (rowIdx > 2) applyMakingDerivedFormulas_(sh, 2, rowIdx - 1);

  SpreadsheetApp.flush();
  var bp = jrRefreshBatchPlanAuto_();
  return { ok: true, rowsWritten: rowIdx - 2, batchPlan: bp };
}

function makingPlanCompute_(p) {
  var maxBatchLbs = Math.max(1, toNum_(p && p.maxBatchLbs) || 50);
  var lines = Array.isArray(p && p.lines) ? p.lines : [];
  var recipesById = {};
  var products = listAllProducts_();
  for (var i = 0; i < products.length; i++) {
    recipesById[String(products[i].id || "")] = products[i];
  }
  var demandByRecipeId = {};
  for (var r = 0; r < lines.length; r++) {
    var rid = String(lines[r] && lines[r].recipeId || "").trim();
    var lbs = toNum_(lines[r] && lines[r].amountLbs);
    if (!rid || lbs <= 0) continue;
    demandByRecipeId[rid] = toNum_(demandByRecipeId[rid]) + lbs;
  }

  var invByName = inventoryQtyByIngredientName_();
  var ingredientTotals = {};
  var recipePlans = [];
  var warnings = [];

  var recipeIds = Object.keys(demandByRecipeId);
  for (var k = 0; k < recipeIds.length; k++) {
    var recipeId = recipeIds[k];
    var product = recipesById[recipeId];
    if (!product) {
      warnings.push("Unknown recipeId: " + recipeId);
      continue;
    }
    var totalLbs = toNum_(demandByRecipeId[recipeId]);
    var pairs = productIngredientPairsFromRow_(product);
    if (!pairs.length) {
      warnings.push("Recipe has no ingredient mix: " + String(product.name || recipeId));
      continue;
    }
    var sumR = 0;
    for (var si = 0; si < pairs.length; si++) sumR += toNum_(pairs[si].ratio);
    if (!(sumR > 0)) {
      warnings.push("Recipe ratios sum to zero: " + String(product.name || recipeId));
      continue;
    }
    var batches = splitToMaxChunks_(totalLbs, maxBatchLbs);
    var ingredients = [];
    for (var pi = 0; pi < pairs.length; pi++) {
      var ingName = String(pairs[pi].name || "").trim();
      var ratioPct = toNum_(pairs[pi].ratio);
      var share = ratioPct / sumR;
      var needTotal = round2_(share * totalLbs);
      if (!(toNum_(needTotal) > 1e-9)) continue;
      var byBatch = [];
      for (var bi = 0; bi < batches.length; bi++) {
        byBatch.push(round2_(share * toNum_(batches[bi])));
      }
      ingredients.push({
        ingredientName: ingName,
        ratioPct: ratioPct,
        totalLbs: needTotal,
        perBatchLbs: byBatch
      });
      var key = ingName.toLowerCase();
      ingredientTotals[key] = toNum_(ingredientTotals[key]) + needTotal;
    }
    recipePlans.push({
      recipeId: recipeId,
      recipeName: String(product.name || ""),
      totalLbs: round2_(totalLbs),
      batches: batches,
      ingredients: ingredients
    });
  }

  var ingredientRows = [];
  var keys = Object.keys(ingredientTotals).sort();
  for (var q = 0; q < keys.length; q++) {
    var key = keys[q];
    var needLbs = round2_(toNum_(ingredientTotals[key]));
    if (!(toNum_(needLbs) > 1e-9)) continue;
    var onHandLbs = round2_(toNum_(invByName[key]));
    ingredientRows.push({
      ingredientName: key,
      needLbs: needLbs,
      onHandLbs: onHandLbs,
      buyLbs: round2_(Math.max(0, needLbs - onHandLbs))
    });
  }

  return {
    ok: true,
    maxBatchLbs: maxBatchLbs,
    recipePlans: recipePlans,
    ingredientTotals: ingredientRows,
    warnings: warnings
  };
}

/**
 * Sum subtotal column by header name (not column index) so misaligned sheets still work.
 * Uses Fix.gs header aliases (same as Calculator snapshot formulas).
 */
function sumSubtotalNonCancelledFromSheetByHeader_(tabName) {
  var sh = sheet_(tabName);
  if (!sh) return 0;
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return 0;
  var hdr = v[0];
  var subL = fixFindColA1FromHeader_(hdr, "subtotalTaxIncl");
  var idxSub = a1LetterToColumnIndex_(subL);
  var statL = fixFindColA1FromHeader_(hdr, "status");
  var idxSt = a1LetterToColumnIndex_(statL);
  if (idxSub < 0) return 0;
  var s = 0;
  for (var r = 1; r < v.length; r++) {
    if (!String(v[r][0] || "").trim()) continue;
    if (idxSt >= 0 && String(v[r][idxSt] || "").trim().toUpperCase() === "CANCELLED") continue;
    s += toNum_(v[r][idxSub]);
  }
  return round2_(s);
}

function countNonCancelledOrderRowsFromSheet_(tabName) {
  var sh = sheet_(tabName);
  if (!sh) return 0;
  var v = sh.getDataRange().getValues();
  if (v.length < 2) return 0;
  var hdr = v[0];
  var statL = fixFindColA1FromHeader_(hdr, "status");
  var idxSt = a1LetterToColumnIndex_(statL);
  var n = 0;
  for (var r = 1; r < v.length; r++) {
    if (!String(v[r][0] || "").trim()) continue;
    if (idxSt >= 0 && String(v[r][idxSt] || "").trim().toUpperCase() === "CANCELLED") continue;
    n++;
  }
  return n;
}

/** If Calculator B shows 0 revenue but orders exist (wrong J/K formulas), patch from raw tabs. */
function repairCalculatorTotalsFromOrderSheets_(out) {
  var cur = toNum_(out.snapshot_revenue_tax_incl_total);
  if (cur > 0) return;
  var rp = sumSubtotalNonCancelledFromSheetByHeader_(TAB_PENDING);
  var ra = sumSubtotalNonCancelledFromSheetByHeader_(TAB_ARCHIVE);
  var total = round2_(rp + ra);
  if (!(total > 0)) return;
  out.snapshot_revenue_tax_incl_total = total;
  out.snapshot_revenue_pre_tax_total = round2_(total / 1.06625);
  out.snapshot_sales_tax_estimated = round2_(total - total / 1.06625);
  var oc = toNum_(out.snapshot_orders_total_count);
  if (!(oc > 0)) {
    oc = countNonCancelledOrderRowsFromSheet_(TAB_PENDING) + countNonCancelledOrderRowsFromSheet_(TAB_ARCHIVE);
  }
  if (oc > 0) out.snapshot_avg_order_value_tax_incl = round2_(total / oc);
}

/**
 * Fallback totals reader kept in Code.gs so action=totals works even if Calculator.gs
 * helpers are not present in the deployed Apps Script project.
 */
function readCalculatorTotalsObject_() {
  var ss = getSpreadsheetForScript_();
  var sh = ss.getSheetByName("Calculator");
  var out = {};
  if (sh && sh.getLastRow() >= 2) {
    var lastR = sh.getLastRow();
    var colA = sh.getRange(2, 1, lastR, 1).getValues();
    var end = 1;
    for (var r = 0; r < colA.length; r++) {
      var k0 = String(colA[r][0] || "").trim();
      if (!k0) break;
      if (k0 === "customer_search_query") break;
      if (!/^[a-z][a-z0-9_]*$/.test(k0)) break;
      end = 2 + r;
    }
    if (end >= 2) {
      var cols = Math.max(3, sh.getLastColumn());
      // getRange(row, column, numRows, numColumns) — end is last data row; numRows = end - 2 + 1
      var numRows = end - 2 + 1;
      var rows = sh.getRange(2, 1, numRows, cols).getValues();
      for (var i = 0; i < rows.length; i++) {
        var key = String(rows[i][0] || "").trim();
        if (!key) continue;
        out[key] = rows[i][1];
      }
    }
  }

  // Lightweight fallback snapshots if calculator keys are empty.
  if (Object.keys(out).length === 0) {
    var pending = listAll_(TAB_PENDING, HEADERS.Pending);
    var archive = listAll_(TAB_ARCHIVE, HEADERS.Archive);
    var expenses = listAll_(TAB_EXPENSES, HEADERS.Expenses);
    var customers = listAll_(TAB_CUSTOMERS, HEADERS.Customers);
    var products = listAllProducts_();
    var ingredients = listAll_(TAB_INGREDIENTS, HEADERS.Ingredients);
    var ingredientInv = listAll_(TAB_INGREDIENT_INVENTORY, HEADERS.IngredientInventory);

    function sumBy_(rows, k) {
      var s = 0;
      for (var j = 0; j < rows.length; j++) s += toNum_(rows[j][k]);
      return round2_(s);
    }

    function sumSubtotalNonCancelled(rows) {
      var s = 0;
      for (var j = 0; j < rows.length; j++) {
        if (String(rows[j].status || "").toUpperCase() === "CANCELLED") continue;
        s += toNum_(rows[j].subtotalTaxIncl);
      }
      return round2_(s);
    }

    var revenuePending = sumSubtotalNonCancelled(pending);
    var revenueArchive = sumSubtotalNonCancelled(archive);

    out.snapshot_now_iso = nowIso_();
    out.snapshot_customers_count = customers.length;
    out.snapshot_products_count = products.length;
    out.snapshot_ingredients_count = ingredients.length;
    var oc =
      pending.filter(function (o) {
        return String(o.status || "").toUpperCase() !== "CANCELLED";
      }).length +
      archive.filter(function (o) {
        return String(o.status || "").toUpperCase() !== "CANCELLED";
      }).length;
    out.snapshot_orders_total_count = oc;
    out.snapshot_expense_rows_count = expenses.length;
    out.snapshot_expense_total = sumBy_(expenses, "amount");
    out.snapshot_pending_revenue_tax_incl = revenuePending;
    out.snapshot_archive_revenue_tax_incl = revenueArchive;
    out.snapshot_revenue_tax_incl_total = round2_(revenuePending + revenueArchive);
    out.snapshot_revenue_pre_tax_total = round2_((revenuePending + revenueArchive) / 1.06625);
    out.snapshot_sales_tax_estimated = round2_(
      revenuePending + revenueArchive - (revenuePending + revenueArchive) / 1.06625
    );
    out.snapshot_avg_order_value_tax_incl = oc > 0 ? round2_((revenuePending + revenueArchive) / oc) : 0;
    out.snapshot_ingredient_inv_rows = ingredientInv.length;
  }
  repairCalculatorTotalsFromOrderSheets_(out);
  return out;
}

/**
 * Match query against Calculator financial keys / notes (column A / C) for action=customerSearch.
 */
function calculatorKeyValueSearchHits_(query) {
  var q = String(query || "").trim().toLowerCase();
  if (!q || q.length < 2) return [];
  var ss = getSpreadsheetForScript_();
  var sh = ss.getSheetByName("Calculator");
  if (!sh || sh.getLastRow() < 2) return [];
  var lastR = sh.getLastRow();
  var colA = sh.getRange(2, 1, lastR, 1).getValues();
  var end = 1;
  for (var r = 0; r < colA.length; r++) {
    var k0 = String(colA[r][0] || "").trim();
    if (!k0) break;
    if (k0 === "customer_search_query") break;
    if (!/^[a-z][a-z0-9_]*$/.test(k0)) break;
    end = 2 + r;
  }
  if (end < 2) return [];
  var numRows = end - 2 + 1;
  var rows = sh.getRange(2, 1, numRows, Math.max(3, sh.getLastColumn())).getValues();
  var hits = [];
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][0] || "").trim();
    var notes = String(rows[i][2] || "").trim();
    if (key.toLowerCase().indexOf(q) >= 0 || notes.toLowerCase().indexOf(q) >= 0) {
      hits.push({ key: key, value: rows[i][1], notes: notes });
      if (hits.length >= 25) break;
    }
  }
  return hits;
}

/**
 * Fallback customer search kept in Code.gs so action=customerSearch works even if
 * Calculator.gs search helpers are not present in deployment.
 */
function customerSearchFromCalculator_(query) {
  var q = String(query || "").trim().toLowerCase();
  if (!q) return { ok: true, customers: [], orders: [] };

  function hit_(v) {
    return String(v || "").toLowerCase().indexOf(q) >= 0;
  }

  var customers = listAll_(TAB_CUSTOMERS, HEADERS.Customers);
  var pending = listAll_(TAB_PENDING, HEADERS.Pending);
  var archive = listAll_(TAB_ARCHIVE, HEADERS.Archive);

  var customerHits = [];
  for (var i = 0; i < customers.length; i++) {
    var c = customers[i];
    if (hit_(c.id) || hit_(c.name) || hit_(c.phone) || hit_(c.email) || hit_(c.address)) {
      customerHits.push(c);
      if (customerHits.length >= 50) break;
    }
  }

  var orders = pending.concat(archive);
  var orderHits = [];
  for (var j = 0; j < orders.length; j++) {
    var o = orders[j];
    if (
      hit_(o.id) ||
      hit_(o.customerName) ||
      hit_(o.phone) ||
      hit_(o.email) ||
      hit_(o.recipe) ||
      hit_(o.invoiceNumber) ||
      hit_(o.notes)
    ) {
      orderHits.push(o);
      if (orderHits.length >= 100) break;
    }
  }

  var calcHits = calculatorKeyValueSearchHits_(query);

  return {
    ok: true,
    query: String(query || ""),
    customers: customerHits,
    orders: orderHits,
    calculatorMatches: calcHits
  };
}

/**
 * Permanently remove an order row from Pending or Archive (web "delete order").
 * payload: { id, bucket: "pending" | "archive" }
 */
function deleteOrder_(p) {
  const id = String(p.id || "").trim();
  if (!id) throw new Error("id is required");
  const bucket = String(p.bucket || "").toLowerCase();
  if (bucket === "pending") {
    deleteById_(sheet_(TAB_PENDING), HEADERS.Pending, id);
    writeAudit_("deleteOrder", TAB_PENDING, id, { bucket: "pending" });
    return { ok: true, id, bucket: "pending" };
  }
  if (bucket === "archive") {
    deleteById_(sheet_(TAB_ARCHIVE), HEADERS.Archive, id);
    writeAudit_("deleteOrder", TAB_ARCHIVE, id, { bucket: "archive" });
    return { ok: true, id, bucket: "archive" };
  }
  throw new Error('bucket must be "pending" or "archive"');
}

function movePendingToArchive_(p) {
  const id = String(p.id || "").trim();
  if (!id) throw new Error("id is required");

  const pendingSheet = sheet_(TAB_PENDING);
  const pending = tableById_(pendingSheet, HEADERS.Pending);
  const item = pending[id];
  if (!item) throw new Error(`Pending row not found: ${id}`);

  const archiveRow = {
    id: item.id,
    createdAt: item.createdAt,
    completedAt: String(p.completedAt || nowIso_()),
    customerName: item.customerName,
    phone: item.phone,
    email: item.email,
    recipe: item.recipe,
    orderItemsJson: item.orderItemsJson,
    quantityLbs: toNum_(item.quantityLbs),
    subtotalTaxIncl: toNum_(item.subtotalTaxIncl),
    status: String(p.status || "FULFILLED"),
    invoiceNumber: item.invoiceNumber,
    invoiceFileId: item.invoiceFileId,
    invoiceUrl: item.invoiceUrl,
    notes: String(p.notes || item.notes || ""),
    updatedAt: nowIso_(),
    promoCode: String(item.promoCode || "").trim(),
    promoDiscountPreTax: toNum_(item.promoDiscountPreTax),
    coOpKickbackOwed: toNum_(item.coOpKickbackOwed),
    preTaxNet: toNum_(item.preTaxNet),
    profit: toNum_(item.profit),
    profitPerLb: toNum_(item.profitPerLb),
    amountPaid: toNum_(item.amountPaid),
    balanceDue: toNum_(item.balanceDue),
    paymentStatus: String(item.paymentStatus || ""),
    paidAt: String(item.paidAt || ""),
    pickedUpAt: String(p.pickedUpAt || item.pickedUpAt || nowIso_())
  };
  attachPromoEconomicsToRow_(archiveRow, archiveRow.promoCode);
  computeProfitFieldsForRow_(archiveRow);
  const state = computeOrderPaymentState_(archiveRow.id, archiveRow.subtotalTaxIncl);
  archiveRow.amountPaid = state.amountPaid;
  archiveRow.balanceDue = state.balanceDue;
  archiveRow.paymentStatus = state.paymentStatus;
  archiveRow.paidAt = state.paidAt || archiveRow.paidAt;
  archiveRow.status = normalizeStatusFromPayment_(archiveRow.status, archiveRow.paymentStatus, true);

  writeById_(TAB_ARCHIVE, archiveRow, HEADERS.Archive);
  moveInvoiceFileToArchiveFolder_(archiveRow.invoiceFileId);
  const inventoryApply = applyInventoryForArchivedOrder_(archiveRow);
  deleteById_(pendingSheet, HEADERS.Pending, id);
  writeAudit_("movePendingToArchive", TAB_ARCHIVE, id, {
    status: archiveRow.status,
    inventoryDeductions: inventoryApply.deductions,
    inventoryMissing: inventoryApply.missing
  });
  return { ok: true, id, inventory: inventoryApply };
}

function archivePaidPickedUpPendingTrigger() {
  ensureSchema_();
  const rows = listAll_(TAB_PENDING, HEADERS.Pending);
  let moved = 0;
  for (const row of rows) {
    if (!isPaidPickedUpStatus_(row.status)) continue;
    movePendingToArchive_({
      id: row.id,
      status: "PICKED_UP",
      completedAt: nowIso_(),
      pickedUpAt: nowIso_(),
      notes: String(row.notes || "")
    });
    moved++;
  }
  writeAudit_("archivePaidPickedUpPendingTrigger", TAB_PENDING, "-", { moved });
  return { ok: true, moved };
}

function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (!sh || sh.getName() !== TAB_PENDING) return;
    const row = e.range.getRow();
    const col = e.range.getColumn();
    if (row <= 1) return;
    const statusCol = HEADERS.Pending.indexOf("status") + 1;
    if (col !== statusCol) return;
    const status = String(sh.getRange(row, statusCol).getValue() || "").trim();
    if (!isPaidPickedUpStatus_(status)) return;
    const idCol = 1;
    const id = String(sh.getRange(row, idCol).getValue() || "").trim();
    if (!id) return;
    movePendingToArchive_({ id, status: "PICKED_UP", completedAt: nowIso_(), pickedUpAt: nowIso_() });
  } catch (err) {
    writeAudit_("onEditError", TAB_PENDING, "-", { error: String(err && err.message ? err.message : err) });
  }
}

function isPaidPickedUpStatus_(status) {
  const s = String(status || "").trim().toLowerCase();
  return s === "paid and picked up" || s === "paid & picked up" || s === "paid_picked_up" || s === "picked up";
}

function computeOrderPaymentState_(orderId, subtotalTaxIncl) {
  const id = String(orderId || "").trim();
  const total = Math.max(0, round2_(toNum_(subtotalTaxIncl)));
  if (!id) return { amountPaid: 0, balanceDue: total, paymentStatus: total > 0 ? "UNPAID" : "PAID", paidAt: "" };
  const rows = listAll_(TAB_PAYMENTS, HEADERS.Payments).filter((r) => String(r.orderId || "").trim() === id);
  let amountPaid = 0;
  let latestPaidAt = "";
  for (const r of rows) {
    const st = String(r.status || "").trim().toUpperCase();
    if (st === "VOID" || st === "CANCELLED" || st === "FAILED" || st === "REFUNDED") continue;
    const amt = Math.max(0, toNum_(r.amount));
    amountPaid += amt;
    const at = String(r.paidAt || r.updatedAt || r.createdAt || "").trim();
    if (at && (!latestPaidAt || new Date(at) > new Date(latestPaidAt))) latestPaidAt = at;
  }
  amountPaid = round2_(amountPaid);
  const balanceDue = round2_(Math.max(0, total - amountPaid));
  const paymentStatus = balanceDue <= 0 ? "PAID" : amountPaid > 0 ? "PARTIAL" : "UNPAID";
  return { amountPaid, balanceDue, paymentStatus, paidAt: paymentStatus === "UNPAID" ? "" : latestPaidAt };
}

function normalizeStatusFromPayment_(currentStatus, paymentStatus, isArchiveRow) {
  const curr = String(currentStatus || "").trim().toUpperCase();
  if (isPaidPickedUpStatus_(curr) || curr === "PICKED_UP") return "PICKED_UP";
  const pay = String(paymentStatus || "").trim().toUpperCase();
  if (isArchiveRow) {
    if (pay === "PAID") return "FULFILLED";
    if (pay === "PARTIAL") return "PARTIAL";
    return curr || "FULFILLED";
  }
  if (pay === "PAID") return "PAID";
  if (pay === "PARTIAL") return "PARTIAL";
  return "PENDING";
}

function syncOrderPaymentFields_(orderId) {
  const id = String(orderId || "").trim();
  if (!id) return;
  const pending = tableById_(sheet_(TAB_PENDING), HEADERS.Pending)[id];
  if (pending) {
    const st = computeOrderPaymentState_(id, toNum_(pending.subtotalTaxIncl));
    patchRowFieldsById_(TAB_PENDING, HEADERS.Pending, id, {
      amountPaid: st.amountPaid,
      balanceDue: st.balanceDue,
      paymentStatus: st.paymentStatus,
      paidAt: st.paidAt,
      status: normalizeStatusFromPayment_(pending.status, st.paymentStatus, false),
      updatedAt: nowIso_()
    });
    return;
  }
  const archived = tableById_(sheet_(TAB_ARCHIVE), HEADERS.Archive)[id];
  if (!archived) return;
  const st = computeOrderPaymentState_(id, toNum_(archived.subtotalTaxIncl));
  patchRowFieldsById_(TAB_ARCHIVE, HEADERS.Archive, id, {
    amountPaid: st.amountPaid,
    balanceDue: st.balanceDue,
    paymentStatus: st.paymentStatus,
    paidAt: st.paidAt,
    status: normalizeStatusFromPayment_(archived.status, st.paymentStatus, true),
    updatedAt: nowIso_()
  });
}

function backfillPaymentStateTrigger() {
  ensureSchema_();
  const pendingRows = listAll_(TAB_PENDING, HEADERS.Pending);
  const archiveRows = listAll_(TAB_ARCHIVE, HEADERS.Archive);
  let pendingUpdated = 0;
  let archiveUpdated = 0;

  for (const row of pendingRows) {
    const id = String(row.id || "").trim();
    if (!id) continue;
    const st = computeOrderPaymentState_(id, toNum_(row.subtotalTaxIncl));
    patchRowFieldsById_(TAB_PENDING, HEADERS.Pending, id, {
      amountPaid: st.amountPaid,
      balanceDue: st.balanceDue,
      paymentStatus: st.paymentStatus,
      paidAt: st.paidAt,
      status: normalizeStatusFromPayment_(row.status, st.paymentStatus, false),
      updatedAt: nowIso_()
    });
    pendingUpdated++;
  }

  for (const row of archiveRows) {
    const id = String(row.id || "").trim();
    if (!id) continue;
    const st = computeOrderPaymentState_(id, toNum_(row.subtotalTaxIncl));
    patchRowFieldsById_(TAB_ARCHIVE, HEADERS.Archive, id, {
      amountPaid: st.amountPaid,
      balanceDue: st.balanceDue,
      paymentStatus: st.paymentStatus,
      paidAt: st.paidAt,
      status: normalizeStatusFromPayment_(row.status, st.paymentStatus, true),
      updatedAt: nowIso_()
    });
    archiveUpdated++;
  }

  writeAudit_("backfillPaymentStateTrigger", "bulk", "-", {
    pendingUpdated,
    archiveUpdated
  });
  return { ok: true, pendingUpdated, archiveUpdated };
}

function moveInvoiceFileToArchiveFolder_(invoiceFileId) {
  const fileId = String(invoiceFileId || "").trim();
  if (!fileId) return;
  try {
    const file = DriveApp.getFileById(fileId);
    const archiveFolder = DriveApp.getFolderById(JR_ARCHIVE_INVOICES_FOLDER_ID);
    archiveFolder.addFile(file);
    const pendingFolder = DriveApp.getFolderById(JR_PENDING_INVOICES_FOLDER_ID);
    pendingFolder.removeFile(file);
  } catch (err) {
    writeAudit_("moveInvoiceFileToArchiveFolderError", TAB_ARCHIVE, "-", {
      invoiceFileId: fileId,
      error: String(err && err.message ? err.message : err)
    });
  }
}


function parseOrderLinesForInventory_(orderRow) {
  const raw = String(orderRow.orderItemsJson || "").trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      /* fall through */
    }
  }
  return [
    {
      productId: "",
      productName: String(orderRow.recipe || "").trim(),
      quantity: toNum_(orderRow.quantityLbs),
      quantityUnit: "lb"
    }
  ];
}

function applyInventoryForArchivedOrder_(orderRow) {
  if (isLegacyInventoryLayout_()) {
    return applyIngredientInventoryForArchivedOrder_(orderRow);
  }
  return applyProductInventoryForArchivedOrder_(orderRow);
}

/** Legacy: subtract ingredient lbs from the Inventory tab using BOM ratios. */
function applyIngredientInventoryForArchivedOrder_(orderRow) {
  const products = listAllProducts_();
  const byProductId = {};
  const byProductName = {};
  for (const p of products) {
    const pid = String(p.id || "").trim();
    const pname = String(p.name || "").trim().toLowerCase();
    if (pid) byProductId[pid] = p;
    if (pname) byProductName[pname] = p;
  }

  const lines = parseOrderLinesForInventory_(orderRow);
  const neededByIngredient = {};

  for (const line of lines) {
    const pid = String(line.productId || "").trim();
    const pname = String(line.productName || "").trim().toLowerCase();
    let product = null;
    if (pid && byProductId[pid]) product = byProductId[pid];
    else if (pname && byProductName[pname]) product = byProductName[pname];
    if (!product) continue;

    const qty = Math.max(0, toNum_(line.quantity));
    const qUnit = String(line.quantityUnit || "lb").toLowerCase();
    const amountPerUnit = Math.max(0.0001, toNum_(product.amountPerUnit || 1));
    const qtyLbs = qUnit === "lb" ? qty : qty * amountPerUnit;
    if (!(qtyLbs > 0)) continue;

    const pairs = productIngredientPairsFromRow_(product);
    for (const pair of pairs) {
      const name = String(pair.name || "").trim().toLowerCase();
      if (!name) continue;
      const usedLbs = qtyLbs * (toNum_(pair.ratio) / 100);
      neededByIngredient[name] = (neededByIngredient[name] || 0) + usedLbs;
    }
  }

  const inv = listAll_(TAB_INVENTORY, HEADERS.IngredientInventory);
  const invByName = {};
  for (const r of inv) {
    const n = String(r.ingredientName || "").trim().toLowerCase();
    if (!n) continue;
    invByName[n] = r;
  }

  const deductions = [];
  const missing = [];
  for (const key of Object.keys(neededByIngredient)) {
    const need = round2_(neededByIngredient[key]);
    const row = invByName[key];
    if (!row) {
      missing.push({ ingredientName: key, neededLbs: need });
      continue;
    }
    const current = toNum_(row.quantityOnHand);
    const next = round2_(current - need);
    patchRowFieldsById_(TAB_INVENTORY, HEADERS.IngredientInventory, row.id, {
      quantityOnHand: next,
      updatedAt: nowIso_()
    });
    deductions.push({
      inventoryId: row.id,
      ingredientName: row.ingredientName,
      usedLbs: need,
      beforeLbs: current,
      afterLbs: next
    });
  }
  return { deductions, missing };
}

/** Product stock: subtract sold finished product (order line qty) from Inventory rows; log each movement. */
function applyProductInventoryForArchivedOrder_(orderRow) {
  const products = listAllProducts_();
  const byProductId = {};
  const byProductName = {};
  for (const p of products) {
    const pid = String(p.id || "").trim();
    const pname = String(p.name || "").trim().toLowerCase();
    if (pid) byProductId[pid] = p;
    if (pname) byProductName[pname] = p;
  }

  const lines = parseOrderLinesForInventory_(orderRow);
  const inv = listAll_(TAB_INVENTORY, HEADERS.Inventory);
  const invByProductId = {};
  for (const r of inv) {
    const pid = String(r.productId || "").trim();
    if (pid) invByProductId[pid] = r;
  }

  const deductions = [];
  const missing = [];
  const orderId = String(orderRow.id || "").trim();

  for (const line of lines) {
    const pid = String(line.productId || "").trim();
    const pname = String(line.productName || "").trim().toLowerCase();
    let product = null;
    if (pid && byProductId[pid]) product = byProductId[pid];
    else if (pname && byProductName[pname]) product = byProductName[pname];
    if (!product) continue;

    const stk = orderLineToProductStockDeduction_(product, line);
    if (!(stk.deduct > 0)) continue;

    const row = invByProductId[String(product.id).trim()];
    if (!row) {
      missing.push({
        productId: product.id,
        productName: product.name,
        needed: stk.deduct,
        unit: stk.unit
      });
      continue;
    }
    const current = toNum_(row.quantityOnHand);
    const next = round2_(current - stk.deduct);
    patchRowFieldsById_(TAB_INVENTORY, HEADERS.Inventory, row.id, {
      quantityOnHand: next,
      updatedAt: nowIso_()
    });
    appendInventoryLog_({
      kind: "ARCHIVE_DEDUCT",
      productId: String(product.id || ""),
      productName: String(product.name || ""),
      deltaQty: -stk.deduct,
      quantityAfter: next,
      unit: stk.unit,
      orderId: orderId,
      notes: "Pendingâ†’Archive"
    });
    deductions.push({
      inventoryId: row.id,
      productId: product.id,
      productName: product.name,
      used: stk.deduct,
      unit: stk.unit,
      beforeQty: current,
      afterQty: next
    });
    invByProductId[String(product.id).trim()] = Object.assign({}, row, { quantityOnHand: next });
  }
  return { deductions, missing };
}

/**
 * External website friendly order submit:
 * {
 *   action: "submitOrder",
 *   customerName, phone, email, address,
 *   items: [{ productId?, productName, quantity, quantityUnit?("lb"|"unit"), unitPrice? }],
 *   notes?,
 *   promoCode?  (optional; COUPON/COOP rules from Settings JR_PROMO_CODES_JSON — kickback $ stored on row)
 * }
 */
function submitOrder_(p) {
  const customerName = String(p.customerName || "").trim();
  if (!customerName) throw new Error("customerName is required");
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) throw new Error("items[] is required");

  const productMapById = tableById_(sheet_(TAB_PRODUCTS), HEADERS.Products);
  const productsByName = listAll_(TAB_PRODUCTS, HEADERS.Products);

  let totalQtyLbs = 0;
  let subtotal = 0;
  const normalizedItems = [];

  for (const raw of items) {
    const q = Math.max(0, toNum_(raw.quantity));
    if (q <= 0) continue;
    const unit = String(raw.quantityUnit || "lb").toLowerCase();
    const pid = String(raw.productId || "").trim();
    const pNameRaw = String(raw.productName || "").trim();

    let prod = null;
    if (pid && productMapById[pid]) prod = productMapById[pid];
    if (!prod && pNameRaw) {
      const n = pNameRaw.toLowerCase();
      prod = productsByName.find((x) => String(x.name || "").toLowerCase() === n) || null;
    }

    const lineName = String((prod && prod.name) || pNameRaw || "Unknown Item");
    const lineUnit = String((prod && prod.unit) || unit || "lb").toLowerCase();
    const unitPrice = raw.unitPrice != null ? toNum_(raw.unitPrice) : toNum_(prod && prod.price);
    const lineAmount = q * unitPrice;
    subtotal += lineAmount;

    // If unit is "lb", quantity contributes directly to quantityLbs. If unit/bag unknown, still store qty in items JSON.
    if (lineUnit === "lb") totalQtyLbs += q;

    normalizedItems.push({
      productId: pid || (prod && prod.id) || "",
      productName: lineName,
      quantity: q,
      quantityUnit: lineUnit,
      unitPrice,
      lineSubtotal: round2_(lineAmount)
    });
  }

  if (!normalizedItems.length) throw new Error("No valid item quantities");

  const summaryNames = normalizedItems.map((x) => `${x.productName} x${x.quantity}`).join(", ");
  const row = {
    id: String(p.id || makeId_("ord")),
    createdAt: String(p.createdAt || nowIso_()),
    customerName,
    phone: String(p.phone || ""),
    email: String(p.email || ""),
    address: String(p.address || ""),
    recipe: normalizedItems.length === 1 ? normalizedItems[0].productName : "Mixed Order",
    orderItemsJson: JSON.stringify(normalizedItems),
    quantityLbs: round2_(totalQtyLbs),
    subtotalTaxIncl: round2_(subtotal),
    status: "PENDING",
    invoiceNumber: "",
    invoiceFileId: "",
    invoiceUrl: "",
    notes: String(p.notes || summaryNames),
    updatedAt: nowIso_(),
    promoCode: "",
    promoDiscountPreTax: 0,
    coOpKickbackOwed: 0,
    preTaxNet: 0,
    profit: 0,
    profitPerLb: 0,
    amountPaid: 0,
    balanceDue: round2_(subtotal),
    paymentStatus: "UNPAID",
    paidAt: "",
    pickedUpAt: ""
  };
  /** Line `subtotal` is treated as tax-inclusive (product shelf prices). Promo economics are finalized here. */
  attachPromoEconomicsToRow_(row, p.promoCode);
  computeProfitFieldsForRow_(row);
  writeById_(TAB_PENDING, row, HEADERS.Pending);
  writeAudit_("submitOrder", TAB_PENDING, row.id, {
    customerName,
    itemCount: normalizedItems.length,
    subtotalTaxIncl: row.subtotalTaxIncl,
    promoCode: row.promoCode,
    coOpKickbackOwed: row.coOpKickbackOwed
  });
  return { ok: true, id: row.id, itemCount: normalizedItems.length, subtotalTaxIncl: row.subtotalTaxIncl };
}

function uploadInvoice_(p) {
  return handleUpload_(p, {
    kind: "invoice",
    folderId: mustProp_("INVOICES_FOLDER_ID"),
    targetSheet: p.targetSheet || TAB_ARCHIVE,
    rowFieldFileId: "invoiceFileId",
    rowFieldUrl: "invoiceUrl",
    header: p.targetSheet === TAB_PENDING ? HEADERS.Pending : HEADERS.Archive
  });
}

function uploadReceipt_(p) {
  return handleExpenseReceiptUpload_(p);
}

/**
 * Readable Drive filename for search, e.g. "1 of 1 - 2026-03-24 - Amazon - Black shopping bags - Packaging - 165.26 - CAPITAL ONE 6507.png"
 */
function guessReceiptFileExtension_(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m === "application/pdf") return ".pdf";
  if (m === "image/png") return ".png";
  if (m === "image/webp") return ".webp";
  if (m === "image/gif") return ".gif";
  if (m.indexOf("image/") === 0) return ".jpg";
  return ".bin";
}

function sanitizeExpenseReceiptTitlePart_(s, maxLen) {
  const max = maxLen || 72;
  let t = String(s || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "—";
  if (t.length > max) t = t.slice(0, max).trim();
  return t;
}

function formatExpenseDateYmd_(expenseDateIso) {
  try {
    const d = new Date(expenseDateIso);
    if (isNaN(d.getTime())) return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
  } catch (err) {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
}

function parseExpenseDescriptionFromNotes_(notes) {
  const n = String(notes || "").trim();
  if (!n) return "";
  const pipe = n.split("|");
  return String(pipe[0] || "").trim();
}

function parseExpensePaymentFromNotes_(notes) {
  const n = String(notes || "").trim();
  if (!n) return "";
  const pipe = n.split("|");
  return String(pipe[1] || "").trim();
}

function buildExpenseReceiptDisplayFileName_(partIndex, partTotal, dateYmd, vendor, description, category, amountStr, payment, ext) {
  const idx = Math.max(1, toNum_(partIndex) || 1);
  const tot = Math.max(idx, toNum_(partTotal) || 1);
  const parts = [
    idx + " of " + tot,
    sanitizeExpenseReceiptTitlePart_(dateYmd, 14),
    sanitizeExpenseReceiptTitlePart_(vendor, 72),
    sanitizeExpenseReceiptTitlePart_(description || "—", 72),
    sanitizeExpenseReceiptTitlePart_(category, 56),
    sanitizeExpenseReceiptTitlePart_(String(amountStr != null ? amountStr : ""), 20),
    sanitizeExpenseReceiptTitlePart_(payment || "—", 56)
  ];
  let stem = parts.join(" - ");
  if (stem.length > 200) stem = stem.slice(0, 200).trim();
  const e = String(ext || ".png");
  const extNorm = e.indexOf(".") === 0 ? e : "." + e;
  return stem + extNorm;
}

function appendExpenseReceiptToRow_(rowId, fileId, url) {
  const expSheet = sheet_(TAB_EXPENSES);
  const rows = tableById_(expSheet, HEADERS.Expenses);
  const exp = rows[rowId];
  if (!exp) throw new Error("Expense not found: " + rowId);
  const sep = " | ";
  const curId = String(exp.receiptFileId || "").trim();
  const curUrl = String(exp.receiptUrl || "").trim();
  const urlTrim = String(url || "").trim();
  if (urlTrim && curUrl) {
    const existing = curUrl.split(sep).map(function (x) {
      return x.trim();
    });
    if (existing.indexOf(urlTrim) >= 0) return false;
  }
  const newId = curId ? curId + sep + fileId : fileId;
  const newUrl = curUrl ? curUrl + sep + urlTrim : urlTrim;
  patchRowFieldsById_(TAB_EXPENSES, HEADERS.Expenses, rowId, {
    receiptFileId: newId,
    receiptUrl: newUrl,
    updatedAt: nowIso_()
  });
  return true;
}

/**
 * Saves one receipt blob into the receipts Drive folder (receiptsFolderId_), appends Drive link(s) on the expense row (supports multiple per expense).
 */
function handleExpenseReceiptUpload_(p) {
  const rowId = String(p.rowId || "").trim();
  if (!rowId) throw new Error("rowId is required");

  const startIso = prop_("UPLOADS_START_AT_ISO") || "";
  const eventAt = String(p.eventAt || nowIso_());
  if (startIso && new Date(eventAt) < new Date(startIso)) {
    return { ok: true, skipped: true, reason: "before_upload_start_cutoff", rowId, eventAt, startIso };
  }

  const expSheet = sheet_(TAB_EXPENSES);
  const rows = tableById_(expSheet, HEADERS.Expenses);
  const exp = rows[rowId];
  if (!exp) throw new Error("Expense not found: " + rowId);

  const vendor = String(p.vendor != null && String(p.vendor).trim() !== "" ? p.vendor : exp.vendor || "");
  const category = String(p.category != null && String(p.category).trim() !== "" ? p.category : exp.category || "");
  const amount = p.amount != null ? toNum_(p.amount) : toNum_(exp.amount);
  const notes = String(p.notes != null ? p.notes : exp.notes || "");
  let paymentMethod = String(p.paymentMethod != null && String(p.paymentMethod).trim() !== "" ? p.paymentMethod : "").trim();
  if (!paymentMethod) paymentMethod = String(exp.paymentMethod || "").trim();
  if (!paymentMethod) paymentMethod = parseExpensePaymentFromNotes_(notes);
  const expenseDate =
    p.expenseDate != null && String(p.expenseDate).trim() !== "" ? String(p.expenseDate) : String(exp.expenseDate || "");
  const description = String(
    p.description != null && String(p.description).trim() !== "" ? p.description : parseExpenseDescriptionFromNotes_(notes)
  );
  const partIndex = Math.max(1, toNum_(p.partIndex) || 1);
  const partTotal = Math.max(partIndex, toNum_(p.partTotal) || 1);

  const mimeType = String(p.mimeType || "image/jpeg");
  const ext = guessReceiptFileExtension_(mimeType);
  const dateYmd = formatExpenseDateYmd_(expenseDate);
  const amountStr = String(round2_(amount));
  const richName = buildExpenseReceiptDisplayFileName_(
    partIndex,
    partTotal,
    dateYmd,
    vendor,
    description,
    category,
    amountStr,
    paymentMethod,
    ext
  );

  const fileName = sanitizeFileNameForReceipt_(richName);
  const base64Data = String(p.base64Data || "").trim();
  const sha256 = String(p.sha256 || "");

  const ledger = sheet_(TAB_UPLOADS_LEDGER);
  const ledgerRows = tableById_(ledger, HEADERS.UploadsLedger);
  const duplicate = Object.keys(ledgerRows)
    .map(function (id) {
      return ledgerRows[id];
    })
    .find(function (r) {
      return r.kind === "receipt" && r.rowId === rowId && (sha256 ? r.sha256 === sha256 : r.fileName === fileName);
    });
  if (duplicate) {
    return {
      ok: true,
      duplicate: true,
      fileId: duplicate.fileId,
      url: duplicate.url,
      rowId,
      kind: "receipt"
    };
  }

  if (!base64Data) throw new Error("base64Data is required");
  const bytes = Utilities.base64Decode(base64Data);
  const blob = Utilities.newBlob(bytes, mimeType, fileName);
  const folder = DriveApp.getFolderById(receiptsFolderId_());
  const file = folder.createFile(blob);
  const fileId = file.getId();
  const url = file.getUrl();

  appendExpenseReceiptToRow_(rowId, fileId, url);

  const ledgerRow = {
    id: makeId_("upl"),
    kind: "receipt",
    sheet: TAB_EXPENSES,
    rowId,
    fileName,
    fileId,
    url,
    sha256,
    createdAt: nowIso_()
  };
  writeById_(TAB_UPLOADS_LEDGER, ledgerRow, HEADERS.UploadsLedger);
  writeAudit_("uploadExpenseReceipt", TAB_UPLOADS_LEDGER, ledgerRow.id, { rowId, fileId, fileName });
  return { ok: true, fileId, url, rowId, kind: "receipt", fileName };
}

function uploadExpenseReceiptsBatch_(p) {
  const rowId = String(p.rowId || "").trim();
  if (!rowId) throw new Error("rowId is required");
  const arr = Array.isArray(p.files) ? p.files : [];
  if (!arr.length) throw new Error("files array is required");
  const meta = p.meta || {};
  const out = { ok: true, uploaded: 0, files: [], errors: [] };
  for (let i = 0; i < arr.length; i++) {
    try {
      const f = arr[i] || {};
      const res = handleExpenseReceiptUpload_({
        rowId: rowId,
        base64Data: f.base64Data,
        mimeType: f.mimeType,
        sha256: f.sha256 || "",
        eventAt: p.eventAt || meta.eventAt,
        partIndex: i + 1,
        partTotal: arr.length,
        vendor: meta.vendor,
        category: meta.category,
        amount: meta.amount,
        paymentMethod: meta.paymentMethod,
        description: meta.description,
        expenseDate: meta.expenseDate,
        notes: meta.notes
      });
      if (res.duplicate || res.skipped) out.files.push(res);
      else {
        out.uploaded++;
        out.files.push(res);
      }
    } catch (err) {
      out.errors.push({ index: i, error: String(err && err.message ? err.message : err) });
    }
  }
  if (!Boolean(p && p.suppressAudit)) {
    writeAudit_("uploadExpenseReceiptsBatch", TAB_EXPENSES, rowId, { uploaded: out.uploaded, errorCount: out.errors.length });
  }
  return out;
}

function bulkUpsert_(p) {
  const expenses = Array.isArray(p.expenses) ? p.expenses : [];
  const pending = Array.isArray(p.pending) ? p.pending : [];
  const archive = Array.isArray(p.archive) ? p.archive : [];
  const out = { ok: true, expenses: 0, pending: 0, archive: 0, errors: [] };
  const suppressAudit = Boolean(p && p.suppressAudit);
  const prevSuppress = AUDIT_SUPPRESSED;
  AUDIT_SUPPRESSED = suppressAudit || prevSuppress;

  try {
    for (const row of expenses) {
      try {
        upsertExpense_(row);
        out.expenses++;
      } catch (err) {
        out.errors.push({ bucket: "expenses", id: row && row.id, error: String(err && err.message ? err.message : err) });
      }
    }
    for (const row of pending) {
      try {
        upsertPending_(row);
        out.pending++;
      } catch (err) {
        out.errors.push({ bucket: "pending", id: row && row.id, error: String(err && err.message ? err.message : err) });
      }
    }
    for (const row of archive) {
      try {
        upsertArchive_(row);
        out.archive++;
      } catch (err) {
        out.errors.push({ bucket: "archive", id: row && row.id, error: String(err && err.message ? err.message : err) });
      }
    }
  } finally {
    AUDIT_SUPPRESSED = prevSuppress;
  }
  if (!suppressAudit) {
    writeAudit_("bulkUpsertSummary", "bulk", "-", {
      expenses: out.expenses,
      pending: out.pending,
      archive: out.archive,
      errorCount: out.errors.length
    });
  }
  return out;
}

function bulkUpload_(p) {
  const files = Array.isArray(p.files) ? p.files : [];
  const out = { ok: true, uploaded: 0, duplicates: 0, skipped: 0, errors: [] };
  const suppressAudit = Boolean(p && p.suppressAudit);
  const prevSuppress = AUDIT_SUPPRESSED;
  AUDIT_SUPPRESSED = suppressAudit || prevSuppress;
  try {
    for (const f of files) {
      try {
        const kind = String((f && f.kind) || "").toLowerCase();
        const res = kind === "invoice" ? uploadInvoice_(f) : uploadReceipt_(f);
        if (res.duplicate) out.duplicates++;
        else if (res.skipped) out.skipped++;
        else out.uploaded++;
      } catch (err) {
        out.errors.push({ rowId: f && f.rowId, kind: f && f.kind, error: String(err && err.message ? err.message : err) });
      }
    }
  } finally {
    AUDIT_SUPPRESSED = prevSuppress;
  }
  if (!suppressAudit) {
    writeAudit_("bulkUploadSummary", "bulk", "-", {
      uploaded: out.uploaded,
      duplicates: out.duplicates,
      skipped: out.skipped,
      errorCount: out.errors.length
    });
  }
  return out;
}

function clearAuditLog_(p) {
  const keepSummary = String((p && p.keepSummary) || "true").toLowerCase() !== "false";
  const sh = sheet_(TAB_AUDIT_LOG);
  const last = sh.getLastRow();
  if (last > 1) {
    sh.deleteRows(2, last - 1);
  }
  if (keepSummary) {
    writeAudit_("auditLogCleared", TAB_AUDIT_LOG, "-", { keptHeader: true });
  }
  return { ok: true, clearedRows: Math.max(0, last - 1) };
}

/**
 * Recompute promo + profit from Products and sync amountPaid/balanceDue from Payments (after invoice PDF upload or manual repair).
 */
function recomputeOrderEconomics_(tabName, header, id) {
  const oid = String(id || "").trim();
  if (!oid) throw new Error("id required");
  const row = tableById_(sheet_(tabName), header)[oid];
  if (!row) throw new Error(`Row not found in ${tabName}: ${oid}`);
  const copy = Object.assign({}, row);
  attachPromoEconomicsToRow_(copy, copy.promoCode);
  computeProfitFieldsForRow_(copy);
  patchRowFieldsById_(tabName, header, oid, {
    promoCode: copy.promoCode,
    promoDiscountPreTax: copy.promoDiscountPreTax,
    coOpKickbackOwed: copy.coOpKickbackOwed,
    preTaxNet: copy.preTaxNet,
    subtotalTaxIncl: copy.subtotalTaxIncl,
    profit: copy.profit,
    profitPerLb: copy.profitPerLb,
    updatedAt: nowIso_()
  });
  syncOrderPaymentFields_(oid);
  return { ok: true, id: oid, tab: tabName };
}

function handleUpload_(p, cfg) {
  const rowId = String(p.rowId || "").trim();
  if (!rowId) throw new Error("rowId is required");

  // Hard cutoff so old rows are never backfilled accidentally.
  const startIso = prop_("UPLOADS_START_AT_ISO") || "";
  const eventAt = String(p.eventAt || nowIso_());
  if (startIso && new Date(eventAt) < new Date(startIso)) {
    return { ok: true, skipped: true, reason: "before_upload_start_cutoff", rowId, eventAt, startIso };
  }

  const fileName = sanitizeFileName_(String(p.fileName || `${cfg.kind}-${rowId}.pdf`));
  const base64Data = String(p.base64Data || "").trim();
  const mimeType = String(p.mimeType || "application/pdf");
  const sha256 = String(p.sha256 || "");

  const ledger = sheet_(TAB_UPLOADS_LEDGER);
  const ledgerRows = tableById_(ledger, HEADERS.UploadsLedger);
  const duplicate = Object.keys(ledgerRows)
    .map((id) => ledgerRows[id])
    .find((r) => r.kind === cfg.kind && r.rowId === rowId && (sha256 ? r.sha256 === sha256 : r.fileName === fileName));
  if (duplicate) {
    return {
      ok: true,
      duplicate: true,
      fileId: duplicate.fileId,
      url: duplicate.url,
      rowId,
      kind: cfg.kind
    };
  }

  if (!base64Data) throw new Error("base64Data is required");
  const bytes = Utilities.base64Decode(base64Data);
  const blob = Utilities.newBlob(bytes, mimeType, fileName);
  const folder = DriveApp.getFolderById(cfg.folderId);
  const file = folder.createFile(blob);
  const fileId = file.getId();
  const url = file.getUrl();

  // Update source row with latest file ref.
  patchRowFieldsById_(cfg.targetSheet, cfg.header, rowId, {
    [cfg.rowFieldFileId]: fileId,
    [cfg.rowFieldUrl]: url,
    updatedAt: nowIso_()
  });

  const ledgerRow = {
    id: makeId_("upl"),
    kind: cfg.kind,
    sheet: cfg.targetSheet,
    rowId,
    fileName,
    fileId,
    url,
    sha256,
    createdAt: nowIso_()
  };
  writeById_(TAB_UPLOADS_LEDGER, ledgerRow, HEADERS.UploadsLedger);
  writeAudit_("uploadFile", TAB_UPLOADS_LEDGER, ledgerRow.id, { kind: cfg.kind, rowId, fileId });
  if (cfg.kind === "invoice") {
    try {
      if (cfg.targetSheet === TAB_PENDING) recomputeOrderEconomics_(TAB_PENDING, HEADERS.Pending, rowId);
      else if (cfg.targetSheet === TAB_ARCHIVE) recomputeOrderEconomics_(TAB_ARCHIVE, HEADERS.Archive, rowId);
    } catch (err) {
      writeAudit_("recomputeOrderEconomicsAfterInvoiceError", String(cfg.targetSheet || ""), rowId, {
        error: String(err && err.message ? err.message : err)
      });
    }
  }
  return { ok: true, fileId, url, rowId, kind: cfg.kind };
}

function getHeaderRow_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map((v) => String(v || "").trim());
}

function listAllProducts_() {
  const sh = sheet_(TAB_PRODUCTS);
  const header = getHeaderRow_(sh);
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = values[r][c];
    if (!String(row.id || "").trim()) continue;
    out.push(row);
  }
  return out;
}

function productIngredientPairsFromRow_(row) {
  const pairs = [];
  const keys = Object.keys(row || {});
  for (const k of keys) {
    const m = /^ingredient (\d+)$/i.exec(String(k || "").trim());
    if (!m) continue;
    const idx = m[1];
    const name = String(row[`ingredient ${idx}`] || "").trim();
    const ratio = toNum_(row[`ingredient ${idx} ratio`]);
    if (!name || ratio <= 0) continue;
    pairs.push({ name, ratio });
  }
  return pairs.sort((a, b) => b.ratio - a.ratio);
}

function patchProductIngredientPairsById_(productId, pairs) {
  const sh = sheet_(TAB_PRODUCTS);
  const header = getHeaderRow_(sh);
  const values = sh.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0] || "").trim() !== String(productId || "")) continue;
    const rowObj = {};
    for (let c = 0; c < header.length; c++) rowObj[header[c]] = values[r][c];
    for (const h of header) {
      if (/^ingredient \d+$/i.test(h) || /^ingredient \d+ ratio$/i.test(h)) rowObj[h] = "";
    }
    for (let i = 0; i < pairs.length; i++) {
      rowObj[`ingredient ${i + 1}`] = String(pairs[i].ingredientName || pairs[i].name || "").trim();
      rowObj[`ingredient ${i + 1} ratio`] = round2_(toNum_(pairs[i].ratioPercent != null ? pairs[i].ratioPercent : pairs[i].ratio));
    }
    const out = header.map((h) => rowObj[h] != null ? rowObj[h] : "");
    sh.getRange(r + 1, 1, 1, header.length).setValues([out]);
    applyFormulaForProductRow_(sh, header, r + 1);
    return;
  }
  throw new Error(`Row id not found in ${TAB_PRODUCTS}: ${productId}`);
}

function findIngredientIdByName_(name) {
  const target = String(name || "").trim().toLowerCase();
  if (!target) return "";
  const rows = listAll_(TAB_INGREDIENTS, HEADERS.Ingredients);
  const hit = rows.find((r) => String(r.name || "").trim().toLowerCase() === target);
  return hit ? String(hit.id || "") : "";
}

function recalcSingleProduct_(productId) {
  const rows = listAllProducts_();
  const row = rows.find((x) => String(x.id || "") === String(productId || ""));
  if (!row) return;
  const ingredients = listAll_(TAB_INGREDIENTS, HEADERS.Ingredients);
  const byName = {};
  for (const ing of ingredients) byName[String(ing.name || "").trim().toLowerCase()] = ing;
  const pairs = productIngredientPairsFromRow_(row);
  let costPerLb = 0;
  for (const p of pairs) {
    const ing = byName[String(p.name || "").trim().toLowerCase()];
    const unitCost = toNum_(ing && ing.defaultCost);
    costPerLb += unitCost * (toNum_(p.ratio) / 100);
  }
  patchRowFieldsById_(TAB_PRODUCTS, HEADERS.Products, productId, {
    ingredientCount: pairs.length,
    costPerLb: round2_(costPerLb),
    updatedAt: nowIso_()
  });
  const sh = sheet_(TAB_PRODUCTS);
  const header = getHeaderRow_(sh);
  const values = sh.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0] || "").trim() === String(productId || "")) {
      applyFormulaForProductRow_(sh, header, r + 1);
      break;
    }
  }
}

function recalcProducts_() {
  const rows = listAllProducts_();
  for (const row of rows) recalcSingleProduct_(row.id);
  refreshIngredientUsageSummary_();
  writeAudit_("recalcProducts", TAB_PRODUCTS, "-", { count: rows.length });
  return { ok: true, recalculated: rows.length };
}

function pullSince_(sinceIso) {
  const since = sinceIso ? new Date(sinceIso) : null;
  const expenses = listSince_(TAB_EXPENSES, HEADERS.Expenses, since, "updatedAt");
  const pending = listSince_(TAB_PENDING, HEADERS.Pending, since, "updatedAt");
  const archive = listSince_(TAB_ARCHIVE, HEADERS.Archive, since, "updatedAt");
  const uploads = listSince_(TAB_UPLOADS_LEDGER, HEADERS.UploadsLedger, since, "createdAt");
  const customers = listSince_(TAB_CUSTOMERS, HEADERS.Customers, since, "updatedAt");
  const products = listAllProducts_().filter((r) => {
    if (!since) return true;
    const d = new Date(String(r.updatedAt || r.createdAt || ""));
    return !Number.isNaN(d.getTime()) && d >= since;
  });
  const ingredients = listSince_(TAB_INGREDIENTS, HEADERS.Ingredients, since, "updatedAt");
  const inventory = isLegacyInventoryLayout_()
    ? listSince_(TAB_INVENTORY, HEADERS.IngredientInventory, since, "updatedAt")
    : listSince_(TAB_INVENTORY, HEADERS.Inventory, since, "updatedAt");
  const ingredientInventory = listSince_(TAB_INGREDIENT_INVENTORY, HEADERS.IngredientInventory, since, "updatedAt");
  const inventoryLog = listSince_(TAB_INVENTORY_LOG, HEADERS.InventoryLog, since, "at");
  const payments = listSince_(TAB_PAYMENTS, HEADERS.Payments, since, "updatedAt");
  const kickbackPayments = getSpreadsheetForScript_().getSheetByName(TAB_KICKBACK_PAYMENTS)
    ? listSince_(TAB_KICKBACK_PAYMENTS, HEADERS.KickbackPayments, since, "createdAt")
    : [];
  return {
    ok: true,
    now: nowIso_(),
    expenses,
    pending,
    archive,
    uploads,
    customers,
    products,
    ingredients,
    inventory,
    ingredientInventory,
    inventoryLog,
    payments,
    kickbackPayments,
    settings: settingsMap_()
  };
}

function summary_() {
  const expenses = listAll_(TAB_EXPENSES, HEADERS.Expenses);
  const pending = listAll_(TAB_PENDING, HEADERS.Pending);
  const archive = listAll_(TAB_ARCHIVE, HEADERS.Archive);
  const customers = listAll_(TAB_CUSTOMERS, HEADERS.Customers);
  const products = listAllProducts_();
  const ingredients = listAll_(TAB_INGREDIENTS, HEADERS.Ingredients);
  const inventory = isLegacyInventoryLayout_()
    ? listAll_(TAB_INVENTORY, HEADERS.IngredientInventory)
    : listAll_(TAB_INVENTORY, HEADERS.Inventory);
  const ingredientInventory = listAll_(TAB_INGREDIENT_INVENTORY, HEADERS.IngredientInventory);
  const inventoryLog = listAll_(TAB_INVENTORY_LOG, HEADERS.InventoryLog);
  const payments = listAll_(TAB_PAYMENTS, HEADERS.Payments);
  const settings = settingsMap_();
  const taxRate = toNum_(settings.NJ_TAX_RATE || 0.06625);
  return {
    ok: true,
    counts: {
      expenses: expenses.length,
      pending: pending.length,
      archive: archive.length,
      customers: customers.length,
      products: products.length,
      ingredients: ingredients.length,
      inventory: inventory.length,
      ingredientInventory: ingredientInventory.length,
      inventoryLog: inventoryLog.length,
      payments: payments.length
    },
    totals: {
      expenseAmount: round2_(expenses.reduce((s, r) => s + toNum_(r.amount), 0)),
      pendingSubtotal: round2_(pending.reduce((s, r) => s + toNum_(r.subtotalTaxIncl), 0)),
      archiveSubtotal: round2_(archive.reduce((s, r) => s + toNum_(r.subtotalTaxIncl), 0)),
      archiveSalesTaxEstimated: round2_(archive.reduce((s, r) => s + (toNum_(r.subtotalTaxIncl) * taxRate) / (1 + taxRate), 0))
    },
    settings
  };
}

function auth_(e) {
  const expected = mustProp_("API_KEY");
  const body = parseJsonBodyOrEmpty_(e);
  const gotMaster = (e && e.parameter && e.parameter.apiKey) || body.apiKey || "";
  if (gotMaster && gotMaster === expected) return;

  const sessionTok = extractSessionTokenFromRequest_(e, body);
  if (sessionTok && webSessionIsValid_(sessionTok)) return;

  // Per-site keys in Config tab:
  // key: SITE_KEY:<siteName>  value: <secret>
  const gotSite = (e && e.parameter && e.parameter.siteKey) || body.siteKey || "";
  if (!gotSite) throw new Error("Unauthorized");
  const cfg = configMap_();
  const allowed = Object.keys(cfg)
    .filter((k) => k.indexOf("SITE_KEY:") === 0)
    .map((k) => cfg[k]);
  if (allowed.indexOf(String(gotSite)) === -1) throw new Error("Unauthorized");
}

/** JSON object, URL-encoded form, or e.parameter (for login forms and JSON clients). */
function parsePostPayload_(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    const raw = String(e.postData.contents).trim();
    if (raw.length) {
      if (raw.charAt(0) === "{") {
        try {
          return JSON.parse(raw);
        } catch (err) {
          throw new Error(`Invalid JSON body: ${err}`);
        }
      }
      if (raw.indexOf("=") >= 0) {
        const o = {};
        raw.split("&").forEach((pair) => {
          const i = pair.indexOf("=");
          const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, " ");
          const v = decodeURIComponent(i < 0 ? "" : pair.slice(i + 1)).replace(/\+/g, " ");
          if (k) o[k] = v;
        });
        return o;
      }
    }
  }
  const p = e.parameter || {};
  const out = {};
  Object.keys(p).forEach((k) => {
    out[k] = p[k];
  });
  return out;
}

/** For auth_: session/apiKey in JSON without throwing on urlencoded bodies. */
function parseJsonBodyOrEmpty_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  const raw = String(e.postData.contents).trim();
  if (!raw || raw.charAt(0) !== "{") return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

// --- Web session + HTML login (consolidated; was WebAuth.gs) ---

var WEB_SESSION_CACHE_PREFIX = "jrws:";
var WEB_SESSION_TTL_SEC = 21600;

function extractSessionTokenFromRequest_(e, body) {
  body = body || {};
  var q = (e && e.parameter) || {};
  var fromQuery = String(q.sessionToken || q.session || "").trim();
  if (fromQuery) return fromQuery;
  return String(body.sessionToken || body.session || "").trim();
}

function webSessionIsValid_(token) {
  if (!token) return false;
  var u = CacheService.getScriptCache().get(WEB_SESSION_CACHE_PREFIX + token);
  return u != null && String(u).length > 0;
}

function webSessionCreate_(username) {
  var raw =
    Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  CacheService.getScriptCache().put(
    WEB_SESSION_CACHE_PREFIX + raw,
    String(username),
    WEB_SESSION_TTL_SEC
  );
  return raw;
}

function webLoginSheetValuesAB_() {
  var sh = getSpreadsheetForScript_().getSheetByName(TAB_WEB_LOGIN);
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 2).getValues();
}

function webLoginSheetHasRows_() {
  var values = webLoginSheetValuesAB_();
  for (var i = 0; i < values.length; i++) {
    var u = String(values[i][0] != null ? values[i][0] : "").trim();
    var p = String(values[i][1] != null ? values[i][1] : "").trim();
    if (u && p) return true;
  }
  return false;
}

function webLoginSheetMatches_(username, password) {
  var values = webLoginSheetValuesAB_();
  var uIn = String(username || "").trim();
  var pIn = String(password != null ? password : "").trim();
  for (var i = 0; i < values.length; i++) {
    var u = String(values[i][0] != null ? values[i][0] : "").trim();
    var p = String(values[i][1] != null ? values[i][1] : "").trim();
    if (u === uIn && p === pIn) return true;
  }
  return false;
}

function handleWebLoginPayload_(payload) {
  ensureWebLoginTabMinimal_();
  var u = String((payload && (payload.username || payload.user || payload.email)) || "").trim();
  var p = String((payload && payload.password) != null ? payload.password : "");
  if (!webLoginSheetHasRows_()) {
    return json_({
      ok: false,
      error: "WebLogin tab is empty. Add row 2+ with A=username and B=password."
    });
  }
  if (webLoginSheetMatches_(u, p)) {
    return json_({
      ok: true,
      sessionToken: webSessionCreate_(u),
      expiresInSeconds: WEB_SESSION_TTL_SEC
    });
  }
  Utilities.sleep(300 + Math.floor(Math.random() * 200));
  return json_({ ok: false, error: "Invalid username or password." });
}

function htmlWebLoginPageOutput_() {
  var svcUrl = "";
  try {
    svcUrl = ScriptApp.getService().getUrl();
  } catch (err) {
    svcUrl = "";
  }
  var esc = JSON.stringify(svcUrl || "");
  var html =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">" +
    "<title>JR Hub login</title>" +
    "<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:2rem auto;padding:0 14px;color:#222}" +
    "h1{font-size:1.25rem}label{display:block;margin:.65rem 0 .2rem;font-size:13px}" +
    "input{width:100%;padding:.55rem;box-sizing:border-box;font-size:15px;border:1px solid #ccc;border-radius:6px}" +
    "button{margin-top:1rem;padding:.6rem 1rem;cursor:pointer;border-radius:6px;border:1px solid #333;background:#111;color:#fff;font-size:14px}" +
    "#out{margin-top:1rem;white-space:pre-wrap;font-size:12px;background:#f6f6f6;padding:10px;border-radius:6px;word-break:break-all}" +
    ".hint{color:#666;font-size:13px;margin-top:.5rem}</style></head><body>" +
    "<h1>JR Hub Login</h1>" +
    "<p class=\"hint\">Sign in.</p>" +
    "<form id=\"f\">" +
    "<label>Username</label><input name=\"username\" autocomplete=\"username\" required>" +
    "<label>Password</label><input name=\"password\" type=\"password\" autocomplete=\"current-password\" required>" +
    "<button type=\"submit\">Sign in</button></form>" +
    "<div id=\"out\"></div>" +
    "<script>(function(){var deployed=" +
    esc +
    ";function base(){if(deployed)return deployed;var h=location.href.split(\"?\")[0];return h;}" +
    "document.getElementById(\"f\").addEventListener(\"submit\",function(ev){ev.preventDefault();" +
    "var fd=new FormData(ev.target);var o={action:\"login\",username:fd.get(\"username\"),password:fd.get(\"password\")};" +
    "fetch(base(),{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify(o)})" +
    ".then(function(r){return r.json()})" +
    ".then(function(j){document.getElementById(\"out\").textContent=JSON.stringify(j,null,2);})" +
    ".catch(function(e){document.getElementById(\"out\").textContent=String(e);});});})();</script>" +
    "</body></html>";
  return HtmlService.createHtmlOutput(html).setTitle("JR Hub login").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function listAll_(tabName, header) {
  const sh = sheet_(tabName);
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = values[r][c];
    if (!String(row.id || "").trim()) continue;
    out.push(row);
  }
  return out;
}

function listSince_(tabName, header, since, stampField) {
  const all = listAll_(tabName, header);
  if (!since) return all;
  return all.filter((r) => {
    const d = new Date(String(r[stampField] || r.updatedAt || r.createdAt || ""));
    return !Number.isNaN(d.getTime()) && d >= since;
  });
}

function writeById_(tabName, rowObj, header, extras) {
  const sh = sheet_(tabName);
  const values = sh.getDataRange().getValues();
  const id = String(rowObj.id || "").trim();
  if (!id) throw new Error("row id required");

  let targetRow = -1;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0] || "").trim() === id) {
      targetRow = r + 1;
      break;
    }
  }

  const out = header.map((h) => rowObj[h] != null ? rowObj[h] : "");
  const extra = extras && typeof extras === "object" ? extras : {};
  const fullHeader = getHeaderRow_(sh);
  for (let i = header.length; i < fullHeader.length; i++) {
    const h = fullHeader[i];
    out.push(extra[h] != null ? extra[h] : "");
  }
  if (targetRow > 0) {
    sh.getRange(targetRow, 1, 1, out.length).setValues([out]);
  } else {
    sh.appendRow(out);
  }
}

function patchRowFieldsById_(tabName, header, id, patch) {
  const sh = sheet_(tabName);
  const fullHeader = getHeaderRow_(sh);
  const values = sh.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0] || "").trim() !== String(id || "")) continue;
    const current = {};
    for (let c = 0; c < fullHeader.length; c++) current[fullHeader[c]] = values[r][c];
    Object.keys(patch).forEach((k) => {
      current[k] = patch[k];
    });
    const out = fullHeader.map((h) => current[h] != null ? current[h] : "");
    sh.getRange(r + 1, 1, 1, fullHeader.length).setValues([out]);
    return;
  }
  throw new Error(`Row id not found in ${tabName}: ${id}`);
}

function deleteById_(sheet, header, id) {
  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0] || "").trim() === String(id || "")) {
      sheet.deleteRow(r + 1);
      return;
    }
  }
}

function tableById_(sheet, header) {
  const values = sheet.getDataRange().getValues();
  const out = {};
  for (let r = 1; r < values.length; r++) {
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = values[r][c];
    const id = String(row.id || "").trim();
    if (!id) continue;
    out[id] = row;
  }
  return out;
}

function sheet_(name) {
  const sh = getSpreadsheetForScript_().getSheetByName(name);
  if (!sh) throw new Error(`Missing sheet: ${name}`);
  return sh;
}

function configMap_() {
  const sh = getSpreadsheetForScript_().getSheetByName(TAB_CONFIG);
  if (!sh || sh.getLastRow() < 2) return {};
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  const map = {};
  for (const r of rows) {
    const k = String(r[0] || "").trim();
    if (!k) continue;
    map[k] = String(r[1] || "").trim();
  }
  return map;
}

function settingsMap_() {
  const sh = getSpreadsheetForScript_().getSheetByName(TAB_SETTINGS);
  if (!sh || sh.getLastRow() < 2) return {};
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  const out = {};
  for (const r of rows) {
    const k = String(r[0] || "").trim();
    if (!k) continue;
    out[k] = String(r[1] || "").trim();
  }
  return out;
}

function writeAudit_(action, targetSheet, targetId, details) {
  if (AUDIT_SUPPRESSED) return;
  const sh = sheet_(TAB_AUDIT_LOG);
  const actor = Session.getActiveUser().getEmail() || "api";
  const row = {
    id: makeId_("log"),
    at: nowIso_(),
    actor,
    action: String(action || ""),
    targetSheet: String(targetSheet || ""),
    targetId: String(targetId || ""),
    details: JSON.stringify(details || {})
  };
  writeById_(TAB_AUDIT_LOG, row, HEADERS.AuditLog);
}

function receiptsFolderId_() {
  const fromProp = String(prop_("RECEIPTS_FOLDER_ID") || "").trim();
  if (fromProp) return fromProp;
  const fallback = String(JR_RECEIPTS_FOLDER_ID || "").trim();
  if (!fallback) throw new Error("Missing RECEIPTS_FOLDER_ID (script property) and JR_RECEIPTS_FOLDER_ID default.");
  return fallback;
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function mustProp_(key) {
  const v = prop_(key);
  if (!v) throw new Error(`Missing script property: ${key}`);
  return v;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function makeId_(prefix) {
  return `${prefix}_${Utilities.getUuid().replace(/-/g, "").slice(0, 20)}`;
}

function nowIso_() {
  return new Date().toISOString();
}

function toNum_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toIsoDate_(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return nowIso_();
  return d.toISOString();
}

function round2_(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function sanitizeFileName_(s) {
  return String(s || "file")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

/** Keeps file extension; allows longer stem so receipt titles stay searchable in Drive. */
function sanitizeFileNameForReceipt_(s) {
  const raw = String(s || "receipt.png");
  const m = /\.([a-z0-9]{1,8})$/i.exec(raw);
  const ext = m ? "." + String(m[1]).toLowerCase() : "";
  let stem = ext ? raw.slice(0, raw.length - ext.length) : raw;
  stem = stem
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (stem.length > 220) stem = stem.slice(0, 220).trim();
  return (stem || "receipt") + (ext || ".png");
}

// One-time setup helpers were moved to Fix.gs so Code.gs stays runtime-only.


