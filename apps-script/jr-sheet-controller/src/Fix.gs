/**
 * Formula-first JR sheet engine.
 *
 * Run once:
 *   fix
 *
 * Optional refresh:
 *   fix_refresh_batch_plan
 *
 * Sheet layout (must match Code.gs HEADERS row 1 on Pending / Archive / Expenses):
 *   Pending:  J = subtotalTaxIncl, K = status (then invoice cols…)
 *   Archive:  J = subtotalTaxIncl, K = status (Archive has no address; C = completedAt)
 *   Expenses: E = amount
 *   IngredientInventory: D = quantityOnHand, E = unitCost
 * Calculator snapshot formulas below assume these letters. If you reorder columns, run Code.gs
 * ensureSchema_ or fix headers before JR_refreshCalculatorSnapshotFormulas.
 *
 * Do not run Calculator.gs JR_createCalculatorSheet() after fix() unless you intend to replace
 * this snapshot block — it uses different snapshot_* key names than the Nest hub (which expects
 * snapshot_revenue_tax_incl_total, etc. from getCalculatorSnapshotSeedRows_).
 */
function fix() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("No active spreadsheet.");

  ensureTab_(ss, "Settings", ["key", "value", "updatedAt"]);
  ensureTab_(ss, "WebLogin", ["username", "password", "notes", "updatedAt"]);
  ensureTab_(ss, "Products", ["id", "name", "unit", "amountPerUnit", "price", "costPerLb", "active", "updatedAt"]);
  ensureTab_(ss, "Ingredients", ["id", "name", "unit", "defaultCost", "updatedAt"]);
  ensureTab_(ss, "IngredientInventory", ["id", "ingredientId", "ingredientName", "quantityOnHand", "unitCost", "updatedAt"]);
  ensureTab_(ss, "Making", ["recipeId", "recipeName", "targetLbs", "maxBatchLbs", "batchCount", "batchPlanLbs", "notes"]);
  ensureTab_(ss, "RecipeBook_Auto", ["recipeId", "recipeName", "ingredientName", "ratioPct", "lbsPer50Batch", "ingredientCostPerLb", "costPer50Batch"]);
  ensureTab_(ss, "Shopping_Auto", ["ingredientName", "neededLbs", "onHandLbs", "buyLbs"]);
  ensureTab_(ss, "BatchPlan_Auto", ["recipeId", "recipeName", "batchNo", "batchLbs", "ingredientName", "ingredientLbs"]);
  /** One row per batch: Recipe | Batch label | ingredient, qty, ingredient, qty… (salmon oil as pumps). Filled by jrRefreshBatchPlanAuto_. */
  ensureTab_(ss, "Making_Print", ["recipeName", "batchLabel"]);
  ensureTab_(ss, "Search_Auto", ["kind", "key", "value"]);
  ensureTab_(ss, "Totals_Auto", ["key", "value"]);
  ensureTab_(ss, "Calculator", ["key", "value", "notes"]);
  /** Co-op kickback payouts (matches Code.gs HEADERS.KickbackPayments). Promo definitions stay in Settings → JR_PROMO_CODES_JSON. */
  ensureTab_(ss, "KickbackPayments", [
    "id",
    "paidAt",
    "periodFrom",
    "periodTo",
    "promoCode",
    "promoLabel",
    "amountPaid",
    "notes",
    "createdAt"
  ]);

  setSetting_(ss, "JR_MAKING_MAX_BATCH_LBS", "50");
  setSetting_(ss, "JR_FIX_LAST_RUN_AT", new Date().toISOString());

  ensureProductIngredientPairColumns_(ss, 10);
  trimMakingSheetLegacyColumns_(ss);
  seedMakingInputFormulas_(ss);
  seedRecipeBookFormula_(ss);
  seedShoppingFormula_(ss);
  seedTotalsFormula_(ss);
  seedSearchFormula_(ss);
  seedCalculatorSnapshots_(ss);
  fix_refresh_batch_plan();

  return {
    ok: true,
    spreadsheetId: ss.getId(),
    fixedAt: new Date().toISOString(),
    message: "Formula engine installed: RecipeBook_Auto, Shopping_Auto, BatchPlan_Auto, Making_Print, Totals_Auto, Search_Auto."
  };
}

function fix_refresh_batch_plan() {
  var r = jrRefreshBatchPlanAuto_();
  if (!r || r.ok === false) throw new Error((r && r.error) || "jrRefreshBatchPlanAuto_ failed (run fix() once).");
  return { ok: true, rows: r.rows || 0, makingPrint: r.makingPrint };
}

function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (!sh) return;
    var name = String(sh.getName());
    if (name === "Making" && e.range.getRow() >= 2 && e.range.getColumn() <= 4) {
      fix_refresh_batch_plan();
      return;
    }
    if ((name === "Products" || name === "Ingredients" || name === "IngredientInventory") && e.range.getRow() >= 2) {
      fix_refresh_batch_plan();
      return;
    }
  } catch (err) {
    Logger.log(String(err && err.message ? err.message : err));
  }
}

/** Remove older layouts that printed ingredient totals / shopping on the Making tab (cols H+). */
function trimMakingSheetLegacyColumns_(ss) {
  var sh = ss.getSheetByName("Making");
  if (!sh) return;
  var lastCol = sh.getLastColumn();
  var lastRow = Math.max(sh.getLastRow(), 2);
  if (lastCol > 7) sh.getRange(1, 8, lastRow, lastCol).clearContent();
}

function seedMakingInputFormulas_(ss) {
  var sh = ss.getSheetByName("Making");
  if (!sh) return;
  if (sh.getMaxRows() < 301) sh.insertRowsAfter(sh.getMaxRows(), 301 - sh.getMaxRows());
  sh.getRange("B2").setFormula('=IF(A2="","",IFERROR(VLOOKUP(A2,Products!A:B,2,FALSE),""))');
  sh.getRange("B2").copyTo(sh.getRange("B3:B301"));
  sh.getRange("D2:D301").setValue(50);
  sh.getRange("E2:E301").setFormulaR1C1('=IF(OR(RC[-2]="",RC[-1]=""),"",CEILING(RC[-2]/RC[-1],1))');
  sh.getRange("F2:F301").setFormulaR1C1('=IF(RC[-1]="","",IF(RC[-1]=1,TEXT(RC[-3],"0.##"),TEXT(RC[-2],"0.##")&" x "&TEXT(RC[-1]-1,"0")&" + "&TEXT(RC[-3]-RC[-2]*(RC[-1]-1),"0.##")))');
  sh.autoResizeColumns(1, 7);
}

function seedRecipeBookFormula_(ss) {
  var products = ss.getSheetByName("Products");
  var out = ss.getSheetByName("RecipeBook_Auto");
  if (!products || !out) return;
  clearBody_(out);

  var hdr = products.getRange(1, 1, 1, products.getLastColumn()).getValues()[0];
  var idx = {};
  for (var i = 0; i < hdr.length; i++) idx[String(hdr[i] || "").trim()] = i + 1;
  var stacks = [];
  for (var n = 1; n <= 30; n++) {
    var cName = idx["ingredient " + n];
    var cRatio = idx["ingredient " + n + " ratio"];
    if (!cName || !cRatio) continue;
    var nameA1 = colToA1_(cName);
    var ratioA1 = colToA1_(cRatio);
    stacks.push(
      'IFERROR(FILTER({Products!A2:A,Products!B2:B,Products!' + nameA1 + '2:' + nameA1 + ',Products!' + ratioA1 + '2:' + ratioA1 + '},Products!A2:A<>"",Products!' + nameA1 + '2:' + nameA1 + '<>"",Products!' + ratioA1 + '2:' + ratioA1 + '>0),)'
    );
  }
  if (!stacks.length) return;

  // QUERY cannot use VLOOKUP inside its SELECT in Google Sheets (yields #VALUE!). Base table in A:E, cost in F:G.
  var base =
    '=QUERY({' + stacks.join(";") + '},"select Col1, Col2, Col3, Col4, Col4*0.5 where Col1 is not null", 0)';
  out.getRange("A2").setFormula(base);
  out.getRange("F2").setFormula(
    '=ARRAYFORMULA(IF(LEN(A2:A)=0,,IFERROR(VLOOKUP(LOWER(TEXT(C2:C,"@")),{LOWER(TEXT(Ingredients!B2:B,"@")),Ingredients!E2:E},2,FALSE),0)))'
  );
  out.getRange("G2").setFormula("=ARRAYFORMULA(IF(LEN(A2:A)=0,,E2:E*F2:F))");
}

function seedShoppingFormula_(ss) {
  var out = ss.getSheetByName("Shopping_Auto");
  if (!out) return;
  clearBody_(out);
  out.getRange("A2").setFormula(
    '=ARRAYFORMULA(QUERY({RecipeBook_Auto!C2:C,RecipeBook_Auto!D2:D*IFNA(VLOOKUP(RecipeBook_Auto!A2:A,{Making!A2:A,Making!C2:C},2,false),0)/100},"select Col1,sum(Col2) where Col1 is not null group by Col1 label sum(Col2) \'\'",0))'
  );
  out.getRange("C2").setFormula('=ARRAYFORMULA(IF(A2:A="","",IFNA(VLOOKUP(LOWER(A2:A),{LOWER(IngredientInventory!C2:C),IngredientInventory!D2:D},2,false),0)))');
  out.getRange("D2").setFormula('=ARRAYFORMULA(IF(A2:A="","",IF(B2:B-C2:C>0,B2:B-C2:C,0)))');
}

function seedTotalsFormula_(ss) {
  var sh = ss.getSheetByName("Totals_Auto");
  if (!sh) return;
  clearBody_(sh);
  sh.getRange("A2:B10").setValues([
    ["making_rows_active", '=COUNTA(FILTER(Making!A2:A,Making!A2:A<>""))'],
    ["making_target_lbs_total", '=IFERROR(SUM(FILTER(Making!C2:C,Making!A2:A<>"")),0)'],
    ["recipe_book_rows", '=COUNTA(FILTER(RecipeBook_Auto!A2:A,RecipeBook_Auto!A2:A<>""))'],
    ["shopping_rows", '=COUNTA(FILTER(Shopping_Auto!A2:A,Shopping_Auto!A2:A<>""))'],
    ["shopping_buy_lbs_total", '=IFERROR(SUM(FILTER(Shopping_Auto!D2:D,Shopping_Auto!A2:A<>"")),0)'],
    ["batch_rows", '=COUNTA(FILTER(BatchPlan_Auto!A2:A,BatchPlan_Auto!A2:A<>""))'],
    ["products_count", '=COUNTA(FILTER(Products!A2:A,Products!A2:A<>""))'],
    ["ingredients_count", '=COUNTA(FILTER(Ingredients!A2:A,Ingredients!A2:A<>""))'],
    ["updated_at", '=TEXT(NOW(),"yyyy-mm-dd\\THH:mm:ss")']
  ]);
}

function seedSearchFormula_(ss) {
  var sh = ss.getSheetByName("Search_Auto");
  if (!sh) return;
  clearBody_(sh);
  sh.getRange("A2").setFormula(
    '=ARRAYFORMULA(QUERY({IF(RecipeBook_Auto!A2:A<>"","recipe",""),RecipeBook_Auto!A2:A,RecipeBook_Auto!B2:B&" | "&RecipeBook_Auto!C2:C&" | ratio "&RecipeBook_Auto!D2:D;IF(Shopping_Auto!A2:A<>"","shopping",""),Shopping_Auto!A2:A,Shopping_Auto!A2:A&" | need "&Shopping_Auto!B2:B&" | buy "&Shopping_Auto!D2:D;IF(BatchPlan_Auto!A2:A<>"","batch",""),BatchPlan_Auto!A2:A&"-"&BatchPlan_Auto!C2:C,BatchPlan_Auto!B2:B&" | "&BatchPlan_Auto!E2:E&" | "&BatchPlan_Auto!F2:F},"select Col1,Col2,Col3 where Col1 is not null",0))'
  );
}

/**
 * Read sheet row 1 for header-based column letters (redownloaded sheets may not match J/K).
 */
function fixGetHeaderRow1_(sh) {
  if (!sh || sh.getLastRow() < 1) return [];
  var lc = Math.max(1, sh.getLastColumn());
  return sh.getRange(1, 1, 1, lc).getValues()[0];
}

/**
 * Match header name to column letter (trim/case/spacing insensitive). Aliases for common renames.
 */
function fixFindColA1FromHeader_(headerRow, fieldName) {
  if (!headerRow || !headerRow.length) return "";
  var fn = String(fieldName || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "")
    .replace(/[^a-z0-9]/g, "");
  var candidateSets = {
    subtotaltaxincl: ["subtotaltaxincl", "subtotal", "subtotalincl", "subtotaltax", "ordertotal"],
    status: ["status", "orderstatus"],
    amount: ["amount"],
    quantityonhand: ["quantityonhand", "qtyonhand", "quantity", "onhand"],
    unitcost: ["unitcost", "cost", "avgunitcost"]
  };
  var want = candidateSets[fn] || [fn];
  for (var w = 0; w < want.length; w++) {
    for (var i = 0; i < headerRow.length; i++) {
      var h = String(headerRow[i] || "")
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "")
        .replace(/[^a-z0-9]/g, "");
      if (h === want[w]) return colToA1_(i + 1);
    }
  }
  return "";
}

/**
 * Calculator financial snapshot rows (key, formula, notes). Columns resolved from Pending/Archive row 1
 * (fallback J/K, E expenses, D/E IngredientInventory). Pass spreadsheet when seeding.
 */
function getCalculatorSnapshotSeedRows_(ss) {
  var pSub = "J";
  var pStat = "K";
  var aSub = "J";
  var aStat = "K";
  var expAmt = "E";
  var invQty = "D";
  var invCost = "E";
  if (ss) {
    try {
      var pSh = ss.getSheetByName("Pending");
      var aSh = ss.getSheetByName("Archive");
      var eSh = ss.getSheetByName("Expenses");
      var invSh = ss.getSheetByName("IngredientInventory");
      if (pSh) {
        var ph = fixGetHeaderRow1_(pSh);
        pSub = fixFindColA1FromHeader_(ph, "subtotalTaxIncl") || pSub;
        pStat = fixFindColA1FromHeader_(ph, "status") || pStat;
      }
      if (aSh) {
        var ah = fixGetHeaderRow1_(aSh);
        aSub = fixFindColA1FromHeader_(ah, "subtotalTaxIncl") || aSub;
        aStat = fixFindColA1FromHeader_(ah, "status") || aStat;
      }
      if (eSh) {
        var eh = fixGetHeaderRow1_(eSh);
        expAmt = fixFindColA1FromHeader_(eh, "amount") || expAmt;
      }
      if (invSh) {
        var ih = fixGetHeaderRow1_(invSh);
        invQty = fixFindColA1FromHeader_(ih, "quantityOnHand") || invQty;
        invCost = fixFindColA1FromHeader_(ih, "unitCost") || invCost;
      }
    } catch (err) {
      Logger.log("getCalculatorSnapshotSeedRows_: " + String(err && err.message ? err.message : err));
    }
  }
  /** exclude cancelled in any casing (matches hub). */
  var pOk =
    "Pending!A2:A<>\"\",UPPER(TRIM(Pending!" + pStat + "2:" + pStat + "&\"\"))<>\"CANCELLED\"";
  var aOk =
    "Archive!A2:A<>\"\",UPPER(TRIM(Archive!" + aStat + "2:" + aStat + "&\"\"))<>\"CANCELLED\"";
  var revIncl =
    "SUM(FILTER(Pending!" +
    pSub +
    "2:" +
    pSub +
    "," +
    pOk +
    "))+SUM(FILTER(Archive!" +
    aSub +
    "2:" +
    aSub +
    "," +
    aOk +
    "))";
  var orderCnt =
    "COUNTA(FILTER(Pending!A2:A," + pOk + "))+COUNTA(FILTER(Archive!A2:A," + aOk + "))";
  return [
    ["snapshot_now_iso", '=TEXT(NOW(),"yyyy-mm-dd\\THH:mm:ss")', "Current timestamp"],
    ["snapshot_customers_count", '=COUNTA(FILTER(Customers!A2:A,Customers!A2:A<>""))', "Customer rows"],
    ["snapshot_products_count", '=COUNTA(FILTER(Products!A2:A,Products!A2:A<>""))', "Products count"],
    ["snapshot_ingredients_count", '=COUNTA(FILTER(Ingredients!A2:A,Ingredients!A2:A<>""))', "Ingredients count"],
    ["snapshot_recipe_book_rows", '=COUNTA(FILTER(RecipeBook_Auto!A2:A,RecipeBook_Auto!A2:A<>""))', "Recipe rows"],
    ["snapshot_shopping_rows", '=COUNTA(FILTER(Shopping_Auto!A2:A,Shopping_Auto!A2:A<>""))', "Shopping rows"],
    ["snapshot_shopping_buy_lbs_total", '=IFERROR(SUM(FILTER(Shopping_Auto!D2:D,Shopping_Auto!A2:A<>"")),0)', "Shopping buy lbs"],
    ["snapshot_batch_rows", '=COUNTA(FILTER(BatchPlan_Auto!A2:A,BatchPlan_Auto!A2:A<>""))', "Batch rows"],
    ["snapshot_making_target_lbs_total", '=IFERROR(SUM(FILTER(Making!C2:C,Making!A2:A<>"")),0)', "Making lbs total"],
    [
      "snapshot_expense_total",
      '=IFERROR(SUM(FILTER(Expenses!' + expAmt + "2:" + expAmt + ",Expenses!A2:A<>\"\")),0)",
      "Total expenses"
    ],
    ["snapshot_expense_rows_count", '=COUNTA(FILTER(Expenses!A2:A,Expenses!A2:A<>""))', "Expense row count"],
    ["snapshot_orders_total_count", "=IFERROR(" + orderCnt + ",0)", "Order rows (non-cancelled; matches hub)"],
    [
      "snapshot_revenue_tax_incl_total",
      "=IFERROR(" + revIncl + ",0)",
      "Revenue incl tax (Pending!J + Archive!J = subtotalTaxIncl)"
    ],
    ["snapshot_revenue_pre_tax_total", "=IFERROR((" + revIncl + ")/1.06625,0)", "Revenue pre tax"],
    ["snapshot_sales_tax_estimated", "=IFERROR((" + revIncl + ")-((" + revIncl + ")/1.06625),0)", "Estimated tax"],
    [
      "snapshot_avg_order_value_tax_incl",
      "=IFERROR((" + revIncl + ")/(" + orderCnt + "),0)",
      "AOV incl tax"
    ],
    [
      "snapshot_ingredient_onhand_lbs_total",
      '=IFERROR(SUM(FILTER(IngredientInventory!' +
        invQty +
        "2:" +
        invQty +
        ',IngredientInventory!A2:A<>"")),0)',
      "Ingredient lbs on hand"
    ],
    [
      "snapshot_ingredient_onhand_cost_total",
      '=IFERROR(SUMPRODUCT(FILTER(IngredientInventory!' +
        invQty +
        "2:" +
        invQty +
        ',IngredientInventory!A2:A<>""),FILTER(IngredientInventory!' +
        invCost +
        "2:" +
        invCost +
        ',IngredientInventory!A2:A<>"")),0)',
      "Ingredient on-hand cost"
    ],
    [
      "snapshot_ingredient_inv_rows",
      '=COUNTA(FILTER(IngredientInventory!A2:A,IngredientInventory!A2:A<>""))',
      "Ingredient inventory row count (lots)"
    ],
    ["snapshot_web_login_count", '=IFERROR(COUNTA(FILTER(WebLogin!A2:A,WebLogin!A2:A<>"")),0)', "Web login rows"],
    ["snapshot_search_rows", '=COUNTA(FILTER(Search_Auto!A2:A,Search_Auto!A2:A<>""))', "Search rows"],
    ["snapshot_fix_last_run", '=TEXT(NOW(),"yyyy-mm-dd\\THH:mm:ss")', "Fix run marker"]
  ];
}

function seedCalculatorSnapshots_(ss) {
  var sh = ss.getSheetByName("Calculator");
  if (!sh) return;
  clearBody_(sh);
  var rows = getCalculatorSnapshotSeedRows_(ss);
  // getRange(row, column, numRows, numColumns) — third arg is row COUNT, not end row
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
}

/**
 * One-time (or repeat-safe): append any snapshot rows from getCalculatorSnapshotSeedRows_ that are not yet in column A
 * (stops at first non–snake_case key or customer_search_query). Does not remove or rewrite existing formulas.
 */
function mergeCalculatorSnapshotRows_(ss) {
  var sh = ss.getSheetByName("Calculator");
  if (!sh) return { ok: false, error: "Calculator tab missing" };
  var seed = getCalculatorSnapshotSeedRows_(ss);
  var lastScan = Math.max(sh.getLastRow(), 2);
  var existing = {};
  var lastFin = 1;
  for (var r = 2; r <= lastScan; r++) {
    var k = String(sh.getRange(r, 1).getValue() || "").trim();
    if (!k) break;
    if (k === "customer_search_query") break;
    if (!/^[a-z][a-z0-9_]*$/.test(k)) break;
    existing[k] = true;
    lastFin = r;
  }
  var toAdd = [];
  for (var i = 0; i < seed.length; i++) {
    if (!existing[seed[i][0]]) toAdd.push(seed[i]);
  }
  if (!toAdd.length) return { ok: true, added: 0, keys: [] };
  var start = lastFin < 2 ? 2 : lastFin + 1;
  sh.getRange(start, 1, toAdd.length, 3).setValues(toAdd);
  return { ok: true, added: toAdd.length, keys: toAdd.map(function (row) { return row[0]; }) };
}

/** Run from the Apps Script editor (JR spreadsheet as active) to add new calculator keys without re-running full fix(). */
function JR_mergeCalculatorSnapshotRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("Open the spreadsheet, then run JR_mergeCalculatorSnapshotRows.");
  var res = mergeCalculatorSnapshotRows_(ss);
  Logger.log(JSON.stringify(res));
  return res;
}

/**
 * Rewrite column B/C for every snapshot key that exists in both the sheet and getCalculatorSnapshotSeedRows_.
 * Use after JR_mergeCalculatorSnapshotRows or when an old sheet still points revenue at the wrong columns (F/G vs J).
 */
function JR_refreshCalculatorSnapshotFormulas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("Open the spreadsheet.");
  var sh = ss.getSheetByName("Calculator");
  if (!sh) throw new Error("Calculator tab missing.");
  var seed = getCalculatorSnapshotSeedRows_(ss);
  var byKey = {};
  for (var s = 0; s < seed.length; s++) byKey[seed[s][0]] = seed[s];
  var lastR = Math.max(sh.getLastRow(), 2);
  var keys = [];
  for (var r = 2; r <= lastR; r++) {
    var k = String(sh.getRange(r, 1).getValue() || "").trim();
    if (!byKey[k]) continue;
    var def = byKey[k];
    var f = String(def[1] || "");
    if (f.indexOf("=") === 0) sh.getRange(r, 2).setFormula(f);
    else sh.getRange(r, 2).setValue(f);
    sh.getRange(r, 3).setValue(def[2]);
    keys.push(k);
  }
  Logger.log("JR_refreshCalculatorSnapshotFormulas updated keys: " + keys.join(", "));
  return { ok: true, updatedKeys: keys };
}

/** Fix.gs-only name — do not collide with Code.gs ensureProductIngredientColumns_(pairCount). */
function ensureProductIngredientPairColumns_(ss, pairCount) {
  var sh = ss.getSheetByName("Products");
  if (!sh) return;
  var headers = sh.getRange(1, 1, 1, Math.max(8, sh.getLastColumn())).getValues()[0].map(function (v) { return String(v || "").trim(); });
  var nextCol = headers.length + 1;
  for (var i = 1; i <= pairCount; i++) {
    var n1 = "ingredient " + i;
    var n2 = "ingredient " + i + " ratio";
    if (headers.indexOf(n1) === -1) {
      sh.getRange(1, nextCol, 1, 1).setValue(n1);
      headers.push(n1);
      nextCol++;
    }
    if (headers.indexOf(n2) === -1) {
      sh.getRange(1, nextCol, 1, 1).setValue(n2);
      headers.push(n2);
      nextCol++;
    }
  }
}

function ensureTab_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
    return sh;
  }
  var existing = sh.getRange(1, 1, 1, Math.max(header.length, sh.getLastColumn())).getValues()[0].map(function (v) { return String(v || "").trim(); });
  var mismatch = false;
  for (var i = 0; i < header.length; i++) {
    if (existing[i] !== header[i]) { mismatch = true; break; }
  }
  if (mismatch) sh.getRange(1, 1, 1, header.length).setValues([header]);
  sh.setFrozenRows(1);
  return sh;
}

function setSetting_(ss, key, value) {
  var sh = ss.getSheetByName("Settings");
  if (!sh) return;
  var now = new Date().toISOString();
  var last = sh.getLastRow();
  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0] || "").trim() === key) {
        sh.getRange(i + 2, 1, 1, 3).setValues([[key, String(value), now]]);
        return;
      }
    }
  }
  sh.appendRow([key, String(value), now]);
}

function splitToMax_(totalLbs, maxBatchLbs) {
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

function clearBody_(sh) {
  if (!sh) return;
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(1, sh.getLastColumn())).clearContent();
  }
}

function colToA1_(n) {
  var s = "";
  var x = Number(n || 1);
  while (x > 0) {
    var m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s || "A";
}
