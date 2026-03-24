const fs = require("fs");
const path = require("path");

const API = "http://localhost:4000";
const receiptsRoot = path.resolve(process.cwd(), "Receipts", "extracted", "Receipt Uploads");
const uploadDir = path.resolve(process.cwd(), "apps", "api", "uploads", "expenses");

if (!fs.existsSync(receiptsRoot)) {
  console.error(
    "[migrate-receipts-local] Missing Receipts/extracted/Receipt Uploads.\n" +
      "Restore Receipts/ from backup if you need this one-off migration."
  );
  process.exit(1);
}

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseNotes(notes) {
  const parts = String(notes || "").split(" | ");
  return { description: (parts[0] || "").trim(), payment: (parts[1] || "").trim() };
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(fullPath));
    else out.push(fullPath);
  }
  return out;
}

function amountFromName(name) {
  const matches = name.match(/(?:^|[^0-9-])(\d+(?:\.\d{1,2})?)(?![0-9])/g);
  if (!matches) return null;
  const last = matches[matches.length - 1].replace(/[^0-9.\-]/g, "");
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

function cleanNameBase(name) {
  return norm(
    name
      .replace(/\.[^.]+$/, "")
      .replace(/\b1 of 1\b/gi, "")
      .replace(/\b20\d{2}[-_/]\d{2}[-_/]\d{2}\b/g, "")
      .replace(/\b\d+(?:\.\d{1,2})?\b/g, " ")
  );
}

async function main() {
  fs.mkdirSync(uploadDir, { recursive: true });

  const expenseRes = await fetch(`${API}/operations/expenses`);
  if (!expenseRes.ok) throw new Error(`Cannot load expenses: ${await expenseRes.text()}`);
  const expenses = await expenseRes.json();

  const files = walk(receiptsRoot);
  const fileObjs = files.map((filePath) => {
    const baseName = path.basename(filePath);
    const dateMatch = baseName.match(/(20\d{2})[-_/](\d{2})[-_/](\d{2})/);
    const fileDate = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "";
    return {
      filePath,
      baseName,
      date: fileDate,
      vendorText: norm(baseName),
      amount: amountFromName(baseName),
      base: cleanNameBase(baseName)
    };
  });

  let matched = 0;
  let updated = 0;
  let unmatched = 0;
  const used = new Set();

  for (const ex of expenses) {
    const exDate = dateKey(ex.expenseDate);
    const exAmt = Math.abs(Number(ex.amount || 0));
    const exVendor = norm(ex.vendor || "");
    const { description, payment } = parseNotes(ex.notes);
    const exDesc = norm(description);

    let candidates = fileObjs.filter((f) => !used.has(f.filePath));
    candidates = candidates.filter((f) => !f.date || f.date === exDate);
    if (!candidates.length) {
      unmatched += 1;
      continue;
    }

    let best = null;
    let bestScore = -1;
    for (const c of candidates) {
      let score = 0;
      if (c.date === exDate) score += 4;
      if (exVendor && c.vendorText.includes(exVendor.split(" ")[0])) score += 3;
      if (c.amount !== null && Math.abs(c.amount - exAmt) < 0.02) score += 4;
      if (exDesc && c.base.includes(exDesc.slice(0, 24))) score += 4;
      if (exDesc) {
        const words = exDesc.split(" ").filter((w) => w.length > 3);
        let hits = 0;
        for (const w of words.slice(0, 6)) {
          if (c.base.includes(w)) hits += 1;
        }
        score += hits;
      }
      if (payment && c.base.includes(norm(payment).split(" ")[0])) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (!best || bestScore < 4) {
      unmatched += 1;
      continue;
    }

    matched += 1;
    used.add(best.filePath);

    const ext = path.extname(best.baseName) || ".bin";
    const outName = `exp-${ex.id}${ext.toLowerCase()}`;
    const outPath = path.join(uploadDir, outName);
    fs.copyFileSync(best.filePath, outPath);
    const receiptPath = `/uploads/expenses/${outName}`;

    const body = {
      vendor: String(ex.vendor || ""),
      category: String(ex.category || "Other"),
      amount: Number(ex.amount || 0),
      expenseDate: exDate,
      receiptPath,
      notes: String(ex.notes || "")
    };
    const putRes = await fetch(`${API}/operations/expenses/${ex.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (putRes.ok) updated += 1;
  }

  console.log(
    JSON.stringify({
      files: fileObjs.length,
      expenses: expenses.length,
      matched,
      updated,
      unmatched,
      unusedFiles: fileObjs.length - used.size
    })
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
