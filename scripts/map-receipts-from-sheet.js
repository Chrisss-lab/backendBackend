const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");

const API = "http://localhost:4000";
const sheetPath = path.resolve(process.cwd(), "Receipts", "Buisness Expenses.xlsx");
const filesRoot = path.resolve(process.cwd(), "Receipts", "extracted", "Receipt Uploads");
const uploadDir = path.resolve(process.cwd(), "apps", "api", "uploads", "expenses");

if (!fs.existsSync(sheetPath)) {
  console.error(
    "[map-receipts-from-sheet] Missing Receipts/Buisness Expenses.xlsx.\n" +
      "This is a one-off script — live receipts live under apps/api/uploads/expenses.\n" +
      "Restore Receipts/ from backup if you need to re-run mapping."
  );
  process.exit(1);
}

const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const dateISO = (v) => new Date(v).toISOString().slice(0, 10);
const isLocalReceipt = (v) => String(v || "").startsWith("/uploads/");

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
}

function parseSheetRows() {
  const wb = xlsx.readFile(sheetPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });
  const out = [];
  let lastDate = "";
  for (let i = 4; i < rows.length; i++) {
    const r = rows[i] || [];
    let d = r[0];
    if (typeof d === "number") d = xlsx.SSF.format("yyyy-mm-dd", d);
    d = String(d || "").trim();
    if (d) lastDate = d;
    const expenseDate = (d || lastDate).replace(/\//g, "-");
    const vendor = String(r[1] || "").trim();
    const description = String(r[2] || "").trim();
    const amount = Number(r[4] || 0);
    const payment = String(r[5] || "").trim();
    if (!expenseDate || !vendor || !Number.isFinite(amount)) continue;
    out.push({
      expenseDate,
      vendor,
      description,
      amount,
      payment,
      key: `${expenseDate}|${norm(vendor)}|${norm(description)}|${amount.toFixed(2)}|${norm(payment)}`
    });
  }
  return out;
}

function fileAmount(base) {
  const m = base.match(/(?:^|[^0-9])(\d+(?:\.\d{1,2})?)(?![0-9])/g);
  if (!m) return null;
  const n = Number(m[m.length - 1].replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fileDate(base) {
  const m = base.match(/(20\d{2})[-_/](\d{2})[-_/](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function tokenize(s) {
  return norm(s)
    .split(" ")
    .filter((w) => w.length > 3);
}

async function main() {
  fs.mkdirSync(uploadDir, { recursive: true });
  const sheetRows = parseSheetRows();
  const sheetMap = new Map(sheetRows.map((r) => [r.key, r]));

  const expenseRes = await fetch(`${API}/operations/expenses`);
  const expenses = await expenseRes.json();
  const targetExpenses = expenses.filter((e) => !isLocalReceipt(e.receiptPath));

  const files = walk(filesRoot).map((p) => {
    const base = path.basename(p);
    return { path: p, base, low: norm(base), amount: fileAmount(base), date: fileDate(base), tokens: tokenize(base) };
  });

  let updated = 0;
  let matched = 0;
  const used = new Set();

  for (const ex of targetExpenses) {
    const exDate = dateISO(ex.expenseDate);
    const notes = String(ex.notes || "");
    const [desc = "", payment = ""] = notes.split(" | ");
    const key = `${exDate}|${norm(ex.vendor)}|${norm(desc)}|${Number(ex.amount).toFixed(2)}|${norm(payment)}`;
    const fromSheet = sheetMap.get(key);
    const descTokens = tokenize(fromSheet?.description || desc);
    const vendorToken = tokenize(ex.vendor)[0] || "";
    const amount = Math.abs(Number(ex.amount || 0));

    let best = null;
    let bestScore = -1;
    for (const f of files) {
      if (used.has(f.path)) continue;
      let score = 0;
      if (f.date && f.date === exDate) score += 4;
      if (vendorToken && f.low.includes(vendorToken)) score += 3;
      if (f.amount !== null && Math.abs(f.amount - amount) < 0.02) score += 5;
      let tokenHits = 0;
      for (const t of descTokens.slice(0, 8)) {
        if (f.tokens.includes(t) || f.low.includes(t)) tokenHits++;
      }
      score += tokenHits;
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }

    if (!best) continue;
    // Keep conservative threshold to avoid bad matches.
    if (bestScore < 7) continue;

    const ext = path.extname(best.base) || ".bin";
    const outName = `exp-${ex.id}${ext.toLowerCase()}`;
    fs.copyFileSync(best.path, path.join(uploadDir, outName));
    used.add(best.path);
    matched++;

    const body = {
      vendor: String(ex.vendor || ""),
      category: String(ex.category || "Other"),
      amount: Number(ex.amount || 0),
      expenseDate: exDate,
      receiptPath: `/uploads/expenses/${outName}`,
      notes: String(ex.notes || "")
    };
    const putRes = await fetch(`${API}/operations/expenses/${ex.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (putRes.ok) updated++;
  }

  console.log(JSON.stringify({ sheetRows: sheetRows.length, targetExpenses: targetExpenses.length, files: files.length, matched, updated }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
