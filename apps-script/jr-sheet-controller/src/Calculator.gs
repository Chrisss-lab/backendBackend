/**
 * Calculator tab:
 * 1) P&amp;L-style totals (SUMIFS) — action=totals
 * 2) Instant lookup — FILTER/SEARCH/REGEXREPLACE on Customers + Pending + Archive + Products.
 *    Type or paste in cell JR_SEARCH_QUERY (column B next to key customer_search_query), or call
 *    ?action=customerSearch&query=… (writes that cell, flushes, reads formula spill).
 *
 * Run: JR_createCalculatorSheet()
 */

var TAB_CALCULATOR = "Calculator";
var KEY_CUSTOMER_SEARCH_QUERY = "customer_search_query";

/**
 * Sheet.getRange(row, column, numRows, numColumns) — the last two arguments are heights/widths,
 * not end row/column. E.g. 13 rows from row 2: getRange(2, 1, 13, 3), not getRange(2, 1, 14, 3).
 */
function rngRows_(startRow, endRowInclusive) {
  return Math.max(0, endRowInclusive - startRow + 1);
}

/** Rows below customer_search_query row: header row offset, first formula row offset, block heights */
var SEARCH_OFF_CUST_HEADER = 1;
var SEARCH_OFF_CUST_FORMULA = 2;
var SEARCH_MAX_CUSTOMER_ROWS = 35;
var SEARCH_GAP = 1;
var SEARCH_MAX_PENDING_ROWS = 22;
var SEARCH_MAX_ARCHIVE_ROWS = 22;
var SEARCH_MAX_PRODUCT_ROWS = 22;

var PNL_INVENTORY_EXPENSE_CATEGORIES = [
  "Meats",
  "Organs",
  "Dairy",
  "Fruits/Veggies",
  "Fruits / Veggies",
  "Fats",
  "Supplements",
  "Packaging"
];

function colA1FromHeaderRow_(headerRow, fieldName) {
  var idx = headerRow.indexOf(fieldName);
  if (idx < 0) throw new Error("Calculator setup: missing column " + fieldName + " on sheet");
  return colToA1_(idx + 1);
}

function countifsPendingArchive_(statusColLetter, predicate) {
  var pk = "'Pending'!" + statusColLetter + ":" + statusColLetter;
  var ak = "'Archive'!" + statusColLetter + ":" + statusColLetter;
  if (predicate === "<>CANCELLED") {
    return 'COUNTIF(' + pk + ',"<>CANCELLED")+COUNTIF(' + ak + ',"<>CANCELLED")';
  }
  if (predicate === "=CANCELLED") {
    return 'COUNTIF(' + pk + ',"CANCELLED")+COUNTIF(' + ak + ',"CANCELLED")';
  }
  throw new Error("countifsPendingArchive_: unknown predicate");
}

function formulaExpenseInventorySum_(amountColLetter, categoryColLetter) {
  var parts = [];
  for (var i = 0; i < PNL_INVENTORY_EXPENSE_CATEGORIES.length; i++) {
    var cat = String(PNL_INVENTORY_EXPENSE_CATEGORIES[i] || "").replace(/"/g, '""');
    parts.push(
      "SUMIFS('Expenses'!" +
        amountColLetter +
        ":" +
        amountColLetter +
        ",'Expenses'!" +
        categoryColLetter +
        ":" +
        categoryColLetter +
        ', "' +
        cat +
        '")'
    );
  }
  return parts.join("+");
}

/** Row index (1-based) where A == customer_search_query; -1 if missing */
function findCustomerSearchQueryRow_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var colA = sh.getRange(1, 1, last, 1).getValues();
  for (var i = 0; i < colA.length; i++) {
    if (String(colA[i][0] || "").trim() === KEY_CUSTOMER_SEARCH_QUERY) return i + 1;
  }
  return -1;
}

/** Last row of financial key/value block (column A snake_case keys only), before lookup section */
function findLastFinancialTotalsRow_(sh) {
  var q = findCustomerSearchQueryRow_(sh);
  if (q > 0) {
    for (var r = q - 1; r >= 2; r--) {
      var k = String(sh.getRange(r, 1).getValue() || "").trim();
      if (/^[a-z][a-z0-9_]*$/.test(k)) return r;
    }
    return 1;
  }
  var last = sh.getLastRow();
  if (last < 2) return 1;
  var colA = sh.getRange(2, 1, rngRows_(2, last), 1).getValues();
  var lastFin = 1;
  for (var i = 0; i < colA.length; i++) {
    var k2 = String(colA[i][0] || "").trim();
    if (!k2 || !/^[a-z][a-z0-9_]*$/.test(k2)) break;
    lastFin = 2 + i;
  }
  return lastFin;
}

/**
 * Sheet formula: substring + phone-digit match (>=3 digits in query required for phone arm).
 * bRef e.g. "B42"
 */
function formulaCustomerSearchBlock_(bRef) {
  return (
    "=IF(LEN(TRIM(" +
    bRef +
    '))=0,"", TAKE(IFERROR(FILTER(Customers!$A$2:$H,(LEN(REGEXREPLACE(TRIM(' +
    bRef +
    '),"\\D",""))>=3)*(ISNUMBER(SEARCH(REGEXREPLACE(TRIM(' +
    bRef +
    '),"\\D",""),REGEXREPLACE(Customers!$C$2:$C,"\\D",""))))+(ISNUMBER(SEARCH(LOWER(TRIM(' +
    bRef +
    ')),LOWER(Customers!$A$2:$A&""))))+(ISNUMBER(SEARCH(LOWER(TRIM(' +
    bRef +
    ')),LOWER(Customers!$B$2:$B&""))))+(ISNUMBER(SEARCH(LOWER(TRIM(' +
    bRef +
    ')),LOWER(Customers!$D$2:$D&""))))+(ISNUMBER(SEARCH(LOWER(TRIM(' +
    bRef +
    ')),LOWER(Customers!$E$2:$E&""))))), ' +
    SEARCH_MAX_CUSTOMER_ROWS +
    '), ""))'
  );
}

/** Pending: phone D, name C, email E, concat id A */
function formulaPendingSearchBlock_(bRef) {
  return (
    "=IF(LEN(TRIM(" +
    bRef +
    '))=0,"", TAKE(IFERROR(FILTER(Pending!$A$2:$K,(LEN(REGEXREPLACE(TRIM(' +
    bRef +
    '),"\\D",""))>=3)*(ISNUMBER(SEARCH(REGEXREPLACE(TRIM(' +
    bRef +
    '),"\\D",""),REGEXREPLACE(Pending!$D$2:$D,"\\D",""))))+(ISNUMBER(SEARCH(LOWER(TRIM(' +
    bRef +
    ')),LOWER(Pending!$A$2:$A&Pending!$C$2:$C&Pending!$E$2:$E&Pending!$G$2:$G)))), ' +
    SEARCH_MAX_PENDING_ROWS +
    '), ""))'
  );
}

/** Archive: phone E, name D, email F */
function formulaArchiveSearchBlock_(bRef) {
  return (
    "=IF(LEN(TRIM(" +
    bRef +
    '))=0,"", TAKE(IFERROR(FILTER(Archive!$A$2:$K,(LEN(REGEXREPLACE(TRIM(' +
    bRef +
    '),"\\D",""))>=3)*(ISNUMBER(SEARCH(REGEXREPLACE(TRIM(' +
    bRef +
    '),"\\D",""),REGEXREPLACE(Archive!$E$2:$E,"\\D",""))))+(ISNUMBER(SEARCH(LOWER(TRIM(' +
    bRef +
    ')),LOWER(Archive!$A$2:$A&Archive!$D$2:$D&Archive!$F$2:$F&Archive!$G$2:$G)))), ' +
    SEARCH_MAX_ARCHIVE_ROWS +
    '), ""))'
  );
}

/** Products id, sku, name, price (columns A,B,C and price col letter) */
function formulaProductsSearchBlock_(bRef, priceColLetter) {
  return (
    "=IF(LEN(TRIM(" +
    bRef +
    '))=0,"", TAKE(IFERROR(FILTER(Products!$A$2:$' +
    priceColLetter +
    "$2,(ISNUMBER(SEARCH(LOWER(TRIM(" +
    bRef +
    ")),LOWER(Products!$A$2:$A&Products!$B$2:$B&Products!$C$2:$C&Products!$D$2:$D))))," +
    SEARCH_MAX_PRODUCT_ROWS +
    '), "") )'
  );
}

function setOrReplaceNamedRange_(ss, name, range) {
  var list = ss.getNamedRanges();
  for (var i = 0; i < list.length; i++) {
    if (list[i].getName() === name) {
      list[i].remove();
      break;
    }
  }
  ss.setNamedRange(name, range);
}

function getNamedRangeTopLeft_(ss, name) {
  var list = ss.getNamedRanges();
  for (var i = 0; i < list.length; i++) {
    if (list[i].getName() === name) {
      var r = list[i].getRange();
      return { row: r.getRow(), col: r.getColumn() };
    }
  }
  return null;
}

function JR_createCalculatorSheet() {
  ensureSchema_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB_CALCULATOR);
  if (!sh) sh = ss.insertSheet(TAB_CALCULATOR);

  var pH = getHeaderRow_(sheet_(TAB_PENDING));
  var aH = getHeaderRow_(sheet_(TAB_ARCHIVE));
  var eH = getHeaderRow_(sheet_(TAB_EXPENSES));
  var prodH = getHeaderRow_(sheet_(TAB_PRODUCTS));
  var priceCol = colA1FromHeaderRow_(prodH, "price");

  var pSub = colA1FromHeaderRow_(pH, "subtotalTaxIncl");
  var pStat = colA1FromHeaderRow_(pH, "status");
  var pPre = colA1FromHeaderRow_(pH, "preTaxNet");
  var pProfit = colA1FromHeaderRow_(pH, "profit");

  var aSub = colA1FromHeaderRow_(aH, "subtotalTaxIncl");
  var aStat = colA1FromHeaderRow_(aH, "status");
  var aPre = colA1FromHeaderRow_(aH, "preTaxNet");
  var aProfit = colA1FromHeaderRow_(aH, "profit");

  var expAmt = colA1FromHeaderRow_(eH, "amount");
  var expCat = colA1FromHeaderRow_(eH, "category");

  var revFormula =
    "SUMIFS('Pending'!" +
    pSub +
    ":" +
    pSub +
    ",'Pending'!" +
    pStat +
    ":" +
    pStat +
    ', "<>CANCELLED")+SUMIFS(\'Archive\'!' +
    aSub +
    ":" +
    aSub +
    ",'Archive'!" +
    aStat +
    ":" +
    aStat +
    ', "<>CANCELLED")';

  var netFormula =
    "SUMIFS('Pending'!" +
    pPre +
    ":" +
    pPre +
    ",'Pending'!" +
    pStat +
    ":" +
    pStat +
    ', "<>CANCELLED")+SUMIFS(\'Archive\'!' +
    aPre +
    ":" +
    aPre +
    ",'Archive'!" +
    aStat +
    ":" +
    aStat +
    ', "<>CANCELLED")';

  var profitFormula =
    "SUMIFS('Pending'!" +
    pProfit +
    ":" +
    pProfit +
    ",'Pending'!" +
    pStat +
    ":" +
    pStat +
    ', "<>CANCELLED")+SUMIFS(\'Archive\'!' +
    aProfit +
    ":" +
    aProfit +
    ",'Archive'!" +
    aStat +
    ":" +
    aStat +
    ', "<>CANCELLED")';

  var invPurchFormula = formulaExpenseInventorySum_(expAmt, expCat);
  var expTotalFormula = "SUM('Expenses'!" + expAmt + ":" + expAmt + ")";

  sh.clear();
  sh.getRange(1, 1, 1, 3).setValues([["key", "value", "description"]]);
  sh.getRange(1, 1, 1, 3).setFontWeight("bold");
  sh.setFrozenRows(1);

  var rows = [];
  rows.push([
    "nj_tax_rate",
    '=IFERROR(VALUE(INDEX(FILTER(Settings!B:B,Settings!A:A="NJ_TAX_RATE"),1)),0.06625)',
    "From Settings key NJ_TAX_RATE (column A); default 6.625%."
  ]);
  rows.push([
    "order_revenue_tax_incl",
    "=" + revFormula,
    "Sum subtotalTaxIncl (tax-incl.) for non-cancelled orders in Pending + Archive."
  ]);
  rows.push([
    "order_net_sales",
    "=" + netFormula,
    "Sum preTaxNet for active (non-cancelled) orders."
  ]);
  rows.push([
    "order_gross_profit",
    "=" + profitFormula,
    "Sum stored profit column for active orders."
  ]);
  rows.push(["order_cogs", "=[order_net_sales]-[order_gross_profit]", "Net sales âˆ’ gross profit."]);
  rows.push(["expense_total_all", "=" + expTotalFormula, "All expense amounts."]);
  rows.push([
    "expense_inventory_purchases",
    "=" + invPurchFormula,
    "Inventory-style expense categories (same list as Nest P&amp;L split)."
  ]);
  rows.push([
    "expense_operating_pnl",
    "=[expense_total_all]-[expense_inventory_purchases]",
    "Operating expenses only."
  ]);
  rows.push([
    "net_profit_pnl",
    "=[order_gross_profit]-[expense_operating_pnl]",
    "Gross profit minus operating expenses."
  ]);
  rows.push([
    "orders_active_count",
    "=" + countifsPendingArchive_(pStat, "<>CANCELLED"),
    "Non-cancelled order rows (Pending + Archive)."
  ]);
  rows.push([
    "orders_cancelled_count",
    "=" + countifsPendingArchive_(pStat, "=CANCELLED"),
    "Cancelled rows."
  ]);
  var payH = getHeaderRow_(sheet_(TAB_PAYMENTS));
  var payStatCol = colA1FromHeaderRow_(payH, "status");
  rows.push([
    "payments_paid_record_count",
    '=COUNTIF(\'Payments\'!' + payStatCol + ":" + payStatCol + ',"PAID")',
    "Payments with status PAID."
  ]);

  var invQtyCol = "G";
  try {
    invQtyCol = colA1FromHeaderRow_(getHeaderRow_(sheet_(TAB_INVENTORY)), "quantityOnHand");
  } catch (eInv) {
    invQtyCol = "G";
  }
  rows.push([
    "snapshot_customers_count",
    "=MAX(0,COUNTA(Customers!A2:A)-1)",
    "Precalc for ?action=totals — customer rows (sheet-native, fast)."
  ]);
  rows.push([
    "snapshot_pending_active_count",
    "=COUNTIFS('Pending'!" + pStat + ":" + pStat + ', "<>CANCELLED")',
    "Precalc: non-cancelled Pending rows."
  ]);
  rows.push([
    "snapshot_archive_active_count",
    "=COUNTIFS('Archive'!" + aStat + ":" + aStat + ', "<>CANCELLED")',
    "Precalc: non-cancelled Archive rows."
  ]);
  rows.push([
    "snapshot_products_count",
    "=MAX(0,COUNTA(Products!A2:A)-1)",
    "Precalc: product rows."
  ]);
  rows.push([
    "snapshot_inventory_qty_sum",
    "=IFERROR(SUM(Inventory!" + invQtyCol + "2:" + invQtyCol + "),0)",
    "Precalc: sum quantityOnHand (product inventory layout)."
  ]);
  rows.push([
    "snapshot_ingredient_inv_rows",
    "=MAX(0,COUNTA(" + TAB_INGREDIENT_INVENTORY + "!A2:A)-1)",
    "Precalc: IngredientInventory data rows."
  ]);
  rows.push([
    "snapshot_orders_total_count",
    "=[snapshot_pending_active_count]+[snapshot_archive_active_count]",
    "Non-cancelled order rows only (matches revenue / hub AOV denominator)."
  ]);
  rows.push([
    "snapshot_order_rows_all_incl_cancelled",
    "=[snapshot_pending_active_count]+[snapshot_archive_active_count]+[orders_cancelled_count]",
    "All order rows (active + cancelled) for audit."
  ]);
  rows.push([
    "snapshot_expense_rows_count",
    "=MAX(0,COUNTA(Expenses!A2:A)-1)",
    "Precalc: expense rows."
  ]);
  rows.push([
    "snapshot_pending_revenue_tax_incl",
    "=SUMIFS('Pending'!" + pSub + ":" + pSub + ",'Pending'!" + pStat + ":" + pStat + ', "<>CANCELLED")',
    "Precalc: active Pending subtotalTaxIncl."
  ]);
  rows.push([
    "snapshot_archive_revenue_tax_incl",
    "=SUMIFS('Archive'!" + aSub + ":" + aSub + ",'Archive'!" + aStat + ":" + aStat + ', "<>CANCELLED")',
    "Precalc: active Archive subtotalTaxIncl."
  ]);
  rows.push([
    "snapshot_revenue_tax_incl",
    "=[snapshot_pending_revenue_tax_incl]+[snapshot_archive_revenue_tax_incl]",
    "Precalc: active revenue tax-inclusive (Pending + Archive)."
  ]);
  rows.push([
    "snapshot_net_sales",
    "=[order_net_sales]",
    "Precalc alias for API totals payload."
  ]);
  rows.push([
    "snapshot_gross_profit",
    "=[order_gross_profit]",
    "Precalc alias for API totals payload."
  ]);
  rows.push([
    "snapshot_net_profit_pnl",
    "=[net_profit_pnl]",
    "Precalc alias for API totals payload."
  ]);
  rows.push([
    "snapshot_avg_order_value_tax_incl",
    "=IF([snapshot_orders_total_count]>0,[snapshot_revenue_tax_incl]/[snapshot_orders_total_count],0)",
    "Precalc: average tax-inclusive order value."
  ]);
  rows.push([
    "snapshot_avg_profit_per_order",
    "=IF([snapshot_orders_total_count]>0,[snapshot_gross_profit]/[snapshot_orders_total_count],0)",
    "Precalc: average gross profit per order."
  ]);
  rows.push([
    "snapshot_expense_ratio_pct",
    "=IF([snapshot_revenue_tax_incl]>0,[expense_operating_pnl]/[snapshot_revenue_tax_incl],0)",
    "Precalc: operating expense ratio of tax-inclusive revenue."
  ]);
  rows.push([
    "snapshot_orders_per_customer",
    "=IF([snapshot_customers_count]>0,[snapshot_orders_total_count]/[snapshot_customers_count],0)",
    "Precalc: order rows per customer."
  ]);
  rows.push([
    "snapshot_pending_share_pct",
    "=IF([snapshot_orders_total_count]>0,[snapshot_pending_active_count]/[snapshot_orders_total_count],0)",
    "Precalc: pending active share."
  ]);
  rows.push([
    "snapshot_archive_share_pct",
    "=IF([snapshot_orders_total_count]>0,[snapshot_archive_active_count]/[snapshot_orders_total_count],0)",
    "Precalc: archive active share."
  ]);
  rows.push(["calculator_schema_version", "4", "Schema: v4 = expanded snapshot_* keys + named-range based lookup reads."]);

  var calcFirstRow = 2;
  var calcNumRows = rows.length;
  var calcLastRow = calcFirstRow + calcNumRows - 1;
  sh.getRange(calcFirstRow, 1, calcNumRows, 3).setValues(rows);
  var startRow = calcFirstRow;
  var keyToRow = {};
  for (var r = 0; r < rows.length; r++) {
    keyToRow[rows[r][0]] = startRow + r;
  }
  function br(key) {
    return "B" + keyToRow[key];
  }
  function subPh(formula) {
    return formula
      .replace("[order_net_sales]", br("order_net_sales"))
      .replace("[order_gross_profit]", br("order_gross_profit"))
      .replace("[expense_total_all]", br("expense_total_all"))
      .replace("[expense_inventory_purchases]", br("expense_inventory_purchases"))
      .replace("[expense_operating_pnl]", br("expense_operating_pnl"))
      .replace("[snapshot_pending_active_count]", br("snapshot_pending_active_count"))
      .replace("[snapshot_archive_active_count]", br("snapshot_archive_active_count"))
      .replace("[orders_cancelled_count]", br("orders_cancelled_count"))
      .replace("[snapshot_pending_revenue_tax_incl]", br("snapshot_pending_revenue_tax_incl"))
      .replace("[snapshot_archive_revenue_tax_incl]", br("snapshot_archive_revenue_tax_incl"))
      .replace("[order_net_sales]", br("order_net_sales"))
      .replace("[order_gross_profit]", br("order_gross_profit"))
      .replace("[net_profit_pnl]", br("net_profit_pnl"))
      .replace("[snapshot_orders_total_count]", br("snapshot_orders_total_count"))
      .replace("[snapshot_revenue_tax_incl]", br("snapshot_revenue_tax_incl"))
      .replace("[snapshot_gross_profit]", br("snapshot_gross_profit"))
      .replace("[snapshot_customers_count]", br("snapshot_customers_count"));
  }
  var rngB = sh.getRange(calcFirstRow, 2, calcNumRows, 1);
  var formulas = rngB.getFormulas();
  for (var i = 0; i < formulas.length; i++) {
    var f0 = String(formulas[i][0] || "");
    if (f0.indexOf("[") >= 0) formulas[i][0] = subPh(f0);
  }
  rngB.setFormulas(formulas);
  for (var j = 0; j < rows.length; j++) {
    var lit = rows[j][1];
    var sLit = String(lit != null ? lit : "");
    if (sLit.length === 0 || sLit.charAt(0) === "=") continue;
    sh.getRange(calcFirstRow + j, 2).setValue(lit);
  }

  var searchBase = calcLastRow + 3;
  sh.getRange(searchBase, 1, 1, 11).mergeAcross();
  sh
    .getRange(searchBase, 1)
    .setValue(
      "Instant lookup — type in column B on the row below (key: " +
        KEY_CUSTOMER_SEARCH_QUERY +
        "). Larger result caps; named range JR_SEARCH_QUERY or ?action=customerSearch API."
    )
    .setFontWeight("bold")
    .setWrap(true);

  var qRow = searchBase + 1;
  sh.getRange(qRow, 1, 1, 3).setValues([
    [
      KEY_CUSTOMER_SEARCH_QUERY,
      "",
      "Also: GET ?action=customerSearch&query=… writes this cell and returns JSON (fast; engine is these FILTER formulas)."
    ]
  ]);

  var custHdrRow = qRow + SEARCH_OFF_CUST_HEADER;
  sh.getRange(custHdrRow, 4, 1, 8).setValues([
    ["id", "name", "phone", "email", "address", "notes", "createdAt", "updatedAt"]
  ]);
  sh.getRange(custHdrRow, 4, 1, 8).setFontWeight("bold");

  var bRef = "B" + qRow;
  var custFormRow = qRow + SEARCH_OFF_CUST_FORMULA;
  sh.getRange(custFormRow, 4).setFormula(formulaCustomerSearchBlock_(bRef));

  var pendTitleRow = custFormRow + SEARCH_MAX_CUSTOMER_ROWS + SEARCH_GAP;
  sh.getRange(pendTitleRow, 4).setValue("Matching Pending orders (first " + SEARCH_MAX_PENDING_ROWS + ")").setFontWeight("bold");
  var pendFormRow = pendTitleRow + 1;
  sh.getRange(pendFormRow, 4).setFormula(formulaPendingSearchBlock_(bRef));

  var archTitleRow = pendFormRow + SEARCH_MAX_PENDING_ROWS + SEARCH_GAP;
  sh.getRange(archTitleRow, 4).setValue("Matching Archive orders (first " + SEARCH_MAX_ARCHIVE_ROWS + ")").setFontWeight("bold");
  var archFormRow = archTitleRow + 1;
  sh.getRange(archFormRow, 4).setFormula(formulaArchiveSearchBlock_(bRef));

  var prodTitleRow = archFormRow + SEARCH_MAX_ARCHIVE_ROWS + SEARCH_GAP;
  sh.getRange(prodTitleRow, 4).setValue("Matching Products (id, sku, name… price)").setFontWeight("bold");
  var prodFormRow = prodTitleRow + 1;
  sh.getRange(prodFormRow, 4).setFormula(formulaProductsSearchBlock_(bRef, priceCol));

  setOrReplaceNamedRange_(ss, "JR_SEARCH_QUERY", sh.getRange(qRow, 2));
  setOrReplaceNamedRange_(ss, "JR_SEARCH_CUSTOMERS_TOPLEFT", sh.getRange(custFormRow, 4));
  setOrReplaceNamedRange_(ss, "JR_SEARCH_PENDING_TOPLEFT", sh.getRange(pendFormRow, 4));
  setOrReplaceNamedRange_(ss, "JR_SEARCH_ARCHIVE_TOPLEFT", sh.getRange(archFormRow, 4));
  setOrReplaceNamedRange_(ss, "JR_SEARCH_PRODUCTS_TOPLEFT", sh.getRange(prodFormRow, 4));

  /* Do not setFrozenColumns here: lookup header row merges A:K; Sheets disallows freezing only part of a merge. */
  sh.setColumnWidth(1, 240);
  sh.setColumnWidth(2, 200);
  sh.setColumnWidth(3, 440);
  sh.autoResizeColumns(4, 8);

  var docRow = prodFormRow + SEARCH_MAX_PRODUCT_ROWS + 2;
  sh.getRange(docRow, 1).setValue("Notes & quick links").setFontWeight("bold");
  sh.getRange(docRow + 1, 1, 3, 1).setValues([
    ["action=totals — column A financial keys only (above lookup section)."],
    ["action=customerSearch&query=... — FILTER blocks; phone match needs 3+ digits in query."],
    ["Re-run JR_createCalculatorSheet after changing tab headers."]
  ]);
  sh
    .getRange(docRow + 4, 1)
    .setFormula(
      '=IFERROR(HYPERLINK(TRIM(INDEX(FILTER(Settings!B:B,Settings!A:A="WEB_APP_EXEC_URL"),1))&"?action=loginPage","Open web login page"),"Set WEB_APP_EXEC_URL (run JR_FIX_runOnce_ after deploy)")'
    );
  sh
    .getRange(docRow + 5, 1)
    .setFormula(
      '=IFERROR(HYPERLINK(TRIM(INDEX(FILTER(Settings!B:B,Settings!A:A="WEB_APP_EXEC_URL"),1))&"?action=health","Ping API (health)"),"")'
    );
  sh
    .getRange(docRow + 6, 1)
    .setValue("Editor: run JR_createCalculatorSheet after header changes. API: action=totals, action=customerSearch.");

  try {
    SpreadsheetApp.getUi().alert("Calculator updated (financials + instant formula lookup).");
  } catch (e0) {}
}

/**
 * readCalculatorTotalsObject_ is defined in Code.gs (getSpreadsheetForScript_ + repair from Pending/Archive headers).
 * Do not redeclare here — a duplicate overrides Code.gs and breaks action=totals in the Web App.
 */

function trimEmptyRows_(matrix) {
  var out = [];
  for (var r = 0; r < matrix.length; r++) {
    var row = matrix[r];
    var has = false;
    for (var c = 0; c < row.length; c++) {
      if (String(row[c] != null ? row[c] : "").trim() !== "") {
        has = true;
        break;
      }
    }
    if (!has) break;
    out.push(row);
  }
  return out;
}

function rowsToObjects_(matrix, headers) {
  var list = [];
  for (var r = 0; r < matrix.length; r++) {
    var row = matrix[r];
    var o = {};
    var n = Math.min(headers.length, row.length);
    for (var c = 0; c < n; c++) {
      o[headers[c]] = row[c];
    }
    list.push(o);
  }
  return list;
}

/**
 * Writes query to Calculator lookup cell, flushes, reads formula spill areas (no full-sheet scan).
 */
function customerSearchFromCalculator_(query) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TAB_CALCULATOR);
  if (!sh) throw new Error("Missing Calculator tab — run JR_createCalculatorSheet()");
  var qRef = getNamedRangeTopLeft_(ss, "JR_SEARCH_QUERY");
  var qRow = qRef ? qRef.row : findCustomerSearchQueryRow_(sh);
  var qCol = qRef ? qRef.col : 2;
  if (qRow < 0) throw new Error("Calculator missing " + KEY_CUSTOMER_SEARCH_QUERY + " row — run JR_createCalculatorSheet()");
  sh.getRange(qRow, qCol).setValue(String(query == null ? "" : query));
  SpreadsheetApp.flush();

  var custTop = getNamedRangeTopLeft_(ss, "JR_SEARCH_CUSTOMERS_TOPLEFT");
  var pendTop = getNamedRangeTopLeft_(ss, "JR_SEARCH_PENDING_TOPLEFT");
  var archTop = getNamedRangeTopLeft_(ss, "JR_SEARCH_ARCHIVE_TOPLEFT");
  var prodTop = getNamedRangeTopLeft_(ss, "JR_SEARCH_PRODUCTS_TOPLEFT");

  var custFormRow = custTop ? custTop.row : qRow + SEARCH_OFF_CUST_FORMULA;
  var custFormCol = custTop ? custTop.col : 4;
  var pendFormRow = pendTop ? pendTop.row : custFormRow + SEARCH_MAX_CUSTOMER_ROWS + SEARCH_GAP + 1;
  var pendFormCol = pendTop ? pendTop.col : 4;
  var archFormRow = archTop ? archTop.row : pendFormRow + SEARCH_MAX_PENDING_ROWS + SEARCH_GAP + 1;
  var archFormCol = archTop ? archTop.col : 4;
  var prodFormRow = prodTop ? prodTop.row : archFormRow + SEARCH_MAX_ARCHIVE_ROWS + SEARCH_GAP + 1;
  var prodFormCol = prodTop ? prodTop.col : 4;

  var prodH = getHeaderRow_(sheet_(TAB_PRODUCTS));
  var priceIdx = prodH.indexOf("price");
  if (priceIdx < 0) throw new Error("Products sheet missing price column");
  var prodSpillCols = priceIdx + 1;

  var custRaw = sh.getRange(custFormRow, custFormCol, SEARCH_MAX_CUSTOMER_ROWS, 8).getValues();
  var pendRaw = sh.getRange(pendFormRow, pendFormCol, SEARCH_MAX_PENDING_ROWS, 11).getValues();
  var archRaw = sh.getRange(archFormRow, archFormCol, SEARCH_MAX_ARCHIVE_ROWS, 11).getValues();
  var prodRaw = sh.getRange(prodFormRow, prodFormCol, SEARCH_MAX_PRODUCT_ROWS, prodSpillCols).getValues();

  custRaw = trimEmptyRows_(custRaw);
  pendRaw = trimEmptyRows_(pendRaw);
  archRaw = trimEmptyRows_(archRaw);
  prodRaw = trimEmptyRows_(prodRaw);

  var custHdr = ["id", "name", "phone", "email", "address", "notes", "createdAt", "updatedAt"];
  var pendHdr = HEADERS.Pending.slice(0, 11);
  var archHdr = HEADERS.Archive.slice(0, 11);
  var prodHdr = prodH.slice(0, prodSpillCols);

  return {
    ok: true,
    query: String(query == null ? "" : query),
    customers: rowsToObjects_(custRaw, custHdr),
    pendingOrders: rowsToObjects_(pendRaw, pendHdr),
    archiveOrders: rowsToObjects_(archRaw, archHdr),
    products: rowsToObjects_(prodRaw, prodHdr),
    meta_now: nowIso_()
  };
}


