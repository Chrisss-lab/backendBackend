/**
 * Web order submission — standalone Web App (JSON POST → Pending row; promos from Settings JR_PROMO_CODES_JSON).
 *
 * SAFE IN HUB PROJECT: All helpers use the wos_ prefix so they do not override Code.gs (sheet_, doPost, etc.).
 *
 * PASTE OPTIONS
 * ─────────────
 * • Standalone Apps Script project (recommended): paste this ENTIRE file — doGet/doPost are at the bottom.
 * • Hub project (jr-sheet-controller + this file): paste everything ABOVE the line that says
 *   "HUB: DELETE EVERYTHING BELOW" — or delete only that bottom block — so you do not register a second doPost/doGet.
 *
 * Script properties: API_KEY (required). SPREADSHEET_ID or JR_SPREADSHEET_ID (optional; else default sheet id below).
 * Deploy → Web app → Execute as: Me → share spreadsheet with that account.
 *
 * POST application/json: apiKey, customerName, items[{ productId?, productName, quantity, quantityUnit?, unitPrice? }],
 *   phone?, email?, address?, notes?, promoCode?, id?, createdAt?
 */

var WOS_DEFAULT_SPREADSHEET_ID = "1elG2ZgkujTXMOD8DopImXn4-_eJFleFNFRAkdtW6BPE";
var WOS_TAB_PENDING = "Pending";
var WOS_TAB_PRODUCTS = "Products";
var WOS_TAB_SETTINGS = "Settings";
var WOS_JR_PROMO_CODES_JSON = "JR_PROMO_CODES_JSON";

var WOS_HEADERS_PENDING = [
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
  "pickedUpAt"
];

var WOS_HEADERS_PRODUCTS = [
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
];

function wos_normalizeSpreadsheetId_(raw) {
  var s = String(raw || "").trim();
  if (!s) return "";
  var m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  return m ? m[1] : s;
}

function wos_props_() {
  return PropertiesService.getScriptProperties();
}

function wos_mustApiKey_() {
  var k = String(wos_props_().getProperty("API_KEY") || "").trim();
  if (!k) throw new Error("Set script property API_KEY");
  return k;
}

function wos_openTargetSpreadsheet_() {
  var id =
    wos_normalizeSpreadsheetId_(String(wos_props_().getProperty("SPREADSHEET_ID") || "").trim()) ||
    wos_normalizeSpreadsheetId_(String(wos_props_().getProperty("JR_SPREADSHEET_ID") || "").trim()) ||
    WOS_DEFAULT_SPREADSHEET_ID;
  if (!id) throw new Error("Set SPREADSHEET_ID or JR_SPREADSHEET_ID or keep default id in this file");
  return SpreadsheetApp.openById(id);
}

function wos_isSpreadsheetLike_(ss) {
  return !!(ss && typeof ss.getSheetByName === "function");
}

function wos_ensureTab_(ss, name, header) {
  if (!wos_isSpreadsheetLike_(ss)) throw new Error("wos_ensureTab_: bad spreadsheet");
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
    return;
  }
  var lastCol = Math.max(header.length, sh.getLastColumn());
  var existing = sh
    .getRange(1, 1, 1, lastCol)
    .getValues()[0]
    .map(function (v) {
      return String(v || "").trim();
    });
  var needs = header.some(function (h, i) {
    return existing[i] !== h;
  });
  if (needs) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
  }
}

function wos_ensureSchema_(ss) {
  wos_ensureTab_(ss, WOS_TAB_PENDING, WOS_HEADERS_PENDING);
  wos_ensureTab_(ss, WOS_TAB_PRODUCTS, WOS_HEADERS_PRODUCTS);
  wos_ensureTab_(ss, WOS_TAB_SETTINGS, ["key", "value", "updatedAt"]);
}

function wos_sheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error("Missing sheet: " + name);
  return sh;
}

function wos_getHeaderRow_(sh) {
  return sh
    .getRange(1, 1, 1, sh.getLastColumn())
    .getValues()[0]
    .map(function (v) {
      return String(v || "").trim();
    });
}

function wos_toNum_(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function wos_round2_(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function wos_nowIso_() {
  return new Date().toISOString();
}

function wos_makeId_(prefix) {
  return prefix + "_" + Utilities.getUuid().replace(/-/g, "").slice(0, 20);
}

function wos_listAll_(ss, tabName, header) {
  var sh = wos_sheet_(ss, tabName);
  var values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = {};
    for (var c = 0; c < header.length; c++) row[header[c]] = values[r][c];
    if (!String(row.id || "").trim()) continue;
    out.push(row);
  }
  return out;
}

function wos_tableById_(sheet, header) {
  var values = sheet.getDataRange().getValues();
  var out = {};
  for (var r = 1; r < values.length; r++) {
    var row = {};
    for (var c = 0; c < header.length; c++) row[header[c]] = values[r][c];
    var id = String(row.id || "").trim();
    if (!id) continue;
    out[id] = row;
  }
  return out;
}

function wos_writeById_(ss, tabName, rowObj, header) {
  var sh = wos_sheet_(ss, tabName);
  var values = sh.getDataRange().getValues();
  var id = String(rowObj.id || "").trim();
  if (!id) throw new Error("row id required");

  var targetRow = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0] || "").trim() === id) {
      targetRow = r + 1;
      break;
    }
  }

  var out = header.map(function (h) {
    return rowObj[h] != null ? rowObj[h] : "";
  });
  var fullHeader = wos_getHeaderRow_(sh);
  for (var i = header.length; i < fullHeader.length; i++) {
    out.push("");
  }
  if (targetRow > 0) {
    sh.getRange(targetRow, 1, 1, out.length).setValues([out]);
  } else {
    sh.appendRow(out);
  }
}

function wos_settingsMap_(ss) {
  var sh = ss.getSheetByName(WOS_TAB_SETTINGS);
  if (!sh || sh.getLastRow() < 2) return {};
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  var o = {};
  for (var i = 0; i < rows.length; i++) {
    var k = String(rows[i][0] || "").trim();
    if (!k) continue;
    o[k] = String(rows[i][1] || "").trim();
  }
  return o;
}

function wos_njTaxRate_(ss) {
  return wos_toNum_(wos_settingsMap_(ss).NJ_TAX_RATE || 0.06625);
}

function wos_promoCodesList_(ss) {
  var raw = String(wos_settingsMap_(ss)[WOS_JR_PROMO_CODES_JSON] || "").trim();
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function wos_findPromoByCode_(ss, codeUpper) {
  var c = String(codeUpper || "").trim().toUpperCase();
  if (!c) return null;
  var list = wos_promoCodesList_(ss);
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (String(p.code || "").trim().toUpperCase() !== c) continue;
    if (p.active === false) return null;
    return p;
  }
  return null;
}

function wos_applyPromoToPreTaxNet_(preTaxNet, promo) {
  if (!promo || !(preTaxNet > 0)) return { promoDiscountPreTax: 0, coOpKickbackOwed: 0 };
  var pct = promo.discountPercent != null ? wos_toNum_(promo.discountPercent) : 0;
  var fix = promo.discountFixed != null ? wos_toNum_(promo.discountFixed) : 0;
  var disc = 0;
  if (pct > 0) disc += (preTaxNet * pct) / 100;
  if (fix > 0) disc += fix;
  var promoDiscountPreTax = Math.min(preTaxNet, Math.max(0, disc));
  var kp = promo.kickbackPercent != null ? wos_toNum_(promo.kickbackPercent) : 0;
  var kf = promo.kickbackFixed != null ? wos_toNum_(promo.kickbackFixed) : 0;
  var coOpKickbackOwed = Math.max(0, (preTaxNet * kp) / 100 + kf);
  return { promoDiscountPreTax: promoDiscountPreTax, coOpKickbackOwed: coOpKickbackOwed };
}

function wos_attachPromoEconomicsToRow_(ss, row, promoCodeRaw) {
  var taxR = wos_njTaxRate_(ss);
  var incl = wos_round2_(wos_toNum_(row.subtotalTaxIncl));
  var preTax = incl > 0 ? wos_round2_(incl / (1 + taxR)) : 0;
  var code = String(promoCodeRaw != null ? promoCodeRaw : row.promoCode || "").trim();
  row.promoCode = code;
  var promo = code ? wos_findPromoByCode_(ss, code.toUpperCase()) : null;
  var ap = wos_applyPromoToPreTaxNet_(preTax, promo);
  row.promoDiscountPreTax = ap.promoDiscountPreTax;
  row.coOpKickbackOwed = ap.coOpKickbackOwed;
  row.preTaxNet = preTax;
  if (promo && ap.promoDiscountPreTax > 0) {
    var post = Math.max(0, preTax - ap.promoDiscountPreTax);
    row.subtotalTaxIncl = wos_round2_(post * (1 + taxR));
  }
}

function wos_listAllProducts_(ss) {
  var sh = wos_sheet_(ss, WOS_TAB_PRODUCTS);
  var header = wos_getHeaderRow_(sh);
  var values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = {};
    for (var c = 0; c < header.length; c++) row[header[c]] = values[r][c];
    if (!String(row.id || "").trim()) continue;
    out.push(row);
  }
  return out;
}

function wos_parseOrderLinesForProfit_(row) {
  var raw = String((row && row.orderItemsJson) || "").trim();
  if (raw) {
    try {
      var arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (err) {}
  }
  return [
    {
      productId: "",
      productName: String((row && row.recipe) || "").trim(),
      quantity: wos_toNum_(row && row.quantityLbs),
      quantityUnit: "lb"
    }
  ];
}

function wos_computeProfitFieldsForRow_(ss, row) {
  var lines = wos_parseOrderLinesForProfit_(row);
  var products = wos_listAllProducts_(ss);
  var byId = {};
  var byName = {};
  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    var pid = String(p.id || "").trim();
    var name = String(p.name || "").trim().toLowerCase();
    if (pid) byId[pid] = p;
    if (name) byName[name] = p;
  }

  var totalCost = 0;
  var qtyLbs = 0;
  for (var j = 0; j < lines.length; j++) {
    var line = lines[j];
    var pid2 = String(line.productId || "").trim();
    var pname = String(line.productName || "").trim().toLowerCase();
    var prod = (pid2 && byId[pid2]) || (pname && byName[pname]) || null;
    var q = Math.max(0, wos_toNum_(line.quantity));
    var unit = String(line.quantityUnit || "lb").toLowerCase();
    var amountPerUnit = Math.max(0.0001, wos_toNum_(prod && prod.amountPerUnit ? prod.amountPerUnit : 1));
    var lineLbs = unit === "lb" ? q : q * amountPerUnit;
    qtyLbs += lineLbs;
    var costPerLb = Math.max(0, wos_toNum_(prod && (prod.costPerLb != null ? prod.costPerLb : prod.cost)));
    totalCost += lineLbs * costPerLb;
  }

  var rowQty = Math.max(0, wos_toNum_(row.quantityLbs));
  if (qtyLbs <= 0 && rowQty > 0) qtyLbs = rowQty;
  var preTax = Math.max(0, wos_round2_(wos_toNum_(row.preTaxNet)));
  var profit = wos_round2_(preTax - totalCost);
  var profitPerLb = qtyLbs > 0 ? wos_round2_(profit / qtyLbs) : 0;
  row.profit = profit;
  row.profitPerLb = profitPerLb;
}

/**
 * Same behavior as jr-sheet-controller Code.gs submitOrder_ for the Pending row.
 */
function wos_submitOrder_(ss, p) {
  var customerName = String(p.customerName || "").trim();
  if (!customerName) throw new Error("customerName is required");
  var items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) throw new Error("items[] is required");

  var productSh = wos_sheet_(ss, WOS_TAB_PRODUCTS);
  var productMapById = wos_tableById_(productSh, WOS_HEADERS_PRODUCTS);
  var productsByName = wos_listAll_(ss, WOS_TAB_PRODUCTS, WOS_HEADERS_PRODUCTS);

  var totalQtyLbs = 0;
  var subtotal = 0;
  var normalizedItems = [];

  for (var i = 0; i < items.length; i++) {
    var raw = items[i];
    var q = Math.max(0, wos_toNum_(raw.quantity));
    if (q <= 0) continue;
    var unit = String(raw.quantityUnit || "lb").toLowerCase();
    var pid = String(raw.productId || "").trim();
    var pNameRaw = String(raw.productName || "").trim();

    var prod = null;
    if (pid && productMapById[pid]) prod = productMapById[pid];
    if (!prod && pNameRaw) {
      var n = pNameRaw.toLowerCase();
      for (var k = 0; k < productsByName.length; k++) {
        if (String(productsByName[k].name || "").toLowerCase() === n) {
          prod = productsByName[k];
          break;
        }
      }
    }

    var lineName = String((prod && prod.name) || pNameRaw || "Unknown Item");
    var lineUnit = String((prod && prod.unit) || unit || "lb").toLowerCase();
    var unitPrice = raw.unitPrice != null ? wos_toNum_(raw.unitPrice) : wos_toNum_(prod && prod.price);
    var lineAmount = q * unitPrice;
    subtotal += lineAmount;

    if (lineUnit === "lb") totalQtyLbs += q;

    normalizedItems.push({
      productId: pid || (prod && prod.id) || "",
      productName: lineName,
      quantity: q,
      quantityUnit: lineUnit,
      unitPrice: unitPrice,
      lineSubtotal: wos_round2_(lineAmount)
    });
  }

  if (!normalizedItems.length) throw new Error("No valid item quantities");

  var summaryNames = normalizedItems
    .map(function (x) {
      return x.productName + " x" + x.quantity;
    })
    .join(", ");

  var row = {
    id: String(p.id || wos_makeId_("ord")),
    createdAt: String(p.createdAt || wos_nowIso_()),
    customerName: customerName,
    phone: String(p.phone || ""),
    email: String(p.email || ""),
    address: String(p.address || ""),
    recipe: normalizedItems.length === 1 ? normalizedItems[0].productName : "Mixed Order",
    orderItemsJson: JSON.stringify(normalizedItems),
    quantityLbs: wos_round2_(totalQtyLbs),
    subtotalTaxIncl: wos_round2_(subtotal),
    status: "PENDING",
    invoiceNumber: "",
    invoiceFileId: "",
    invoiceUrl: "",
    notes: String(p.notes || summaryNames),
    updatedAt: wos_nowIso_(),
    promoCode: "",
    promoDiscountPreTax: 0,
    coOpKickbackOwed: 0,
    preTaxNet: 0,
    profit: 0,
    profitPerLb: 0,
    amountPaid: 0,
    balanceDue: wos_round2_(subtotal),
    paymentStatus: "UNPAID",
    paidAt: "",
    pickedUpAt: "",
    paymentMethod: ""
  };

  wos_attachPromoEconomicsToRow_(ss, row, p.promoCode);
  wos_computeProfitFieldsForRow_(ss, row);
  wos_writeById_(ss, WOS_TAB_PENDING, row, WOS_HEADERS_PENDING);

  return { ok: true, id: row.id, itemCount: normalizedItems.length, subtotalTaxIncl: row.subtotalTaxIncl };
}

function wos_jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function wos_checkApiKey_(body) {
  var expected = wos_mustApiKey_();
  var got = String((body && body.apiKey) || "").trim();
  if (!got || got !== expected) throw new Error("Invalid or missing apiKey");
}

function wos_stripAuthFields_(body) {
  var out = {};
  if (!body || typeof body !== "object") return out;
  Object.keys(body).forEach(function (k) {
    if (k === "apiKey" || k === "action") return;
    out[k] = body[k];
  });
  return out;
}

/** Called from Web-order-standalone-Entry.gs doGet */
function wos_webOrderDoGet_() {
  return wos_jsonResponse_({ ok: true, service: "web-order-submission", now: wos_nowIso_() });
}

/** Called from Web-order-standalone-Entry.gs doPost (or single-file standalone bundle). */
function wos_webOrderDoPost_(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return wos_jsonResponse_({ ok: false, error: "Expected POST with JSON body" });
    }
    var body = JSON.parse(e.postData.contents);
    wos_checkApiKey_(body);
    var payload = wos_stripAuthFields_(body);
    var ss = wos_openTargetSpreadsheet_();
    wos_ensureSchema_(ss);
    var result = wos_submitOrder_(ss, payload);
    return wos_jsonResponse_(result);
  } catch (err) {
    return wos_jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// =============================================================================
// HUB: DELETE EVERYTHING BELOW THIS LINE if this file lives in the hub project
// (Code.gs already defines doGet / doPost). Standalone: keep this block.
// =============================================================================

function doGet() {
  return wos_webOrderDoGet_();
}

function doPost(e) {
  return wos_webOrderDoPost_(e);
}
