const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const { PrismaClient, OrderStatus } = require("@prisma/client");

const prisma = new PrismaClient();

const imp = path.resolve(process.cwd(), "data", "import");
const files = {
  jersey: path.join(imp, "Jersey Raw Orders.xlsx"),
  invoice: path.join(imp, "Invoice.xlsx"),
  website: path.join(imp, "webite .xlsx")
};

if (!fs.existsSync(files.jersey)) {
  console.error(
    "[import-orders-from-docs] Missing data/import spreadsheets (e.g. Jersey Raw Orders.xlsx).\n" +
      "This is a one-off migration script — the running app uses SQLite, not these files.\n" +
      "Copy workbooks into data/import/ if you need to re-import."
  );
  process.exit(1);
}

const norm = (v) => String(v || "").trim().toLowerCase();
const phoneDigits = (v) => String(v || "").replace(/\D+/g, "");
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toDate = (v) => {
  if (typeof v === "number") {
    // Excel serial (1900 date system)
    const epoch = Math.round((v - 25569) * 86400 * 1000);
    return new Date(epoch);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function readSheet(filePath, sheetName) {
  const wb = xlsx.readFile(filePath);
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });
  return rows;
}

function parseRows(rows, mapping, status) {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(mapping)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    col[key] = idx;
  }

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => String(c || "").trim() !== "")) continue;
    const name = String(r[col.name] || "").trim();
    const amount = num(r[col.amount]);
    const date = toDate(r[col.date]);
    if (!name || !amount || !date) continue;
    out.push({
      name,
      phone: String(r[col.phone] || "").trim(),
      email: String(r[col.email] || "").trim(),
      address: String(r[col.address] || "").trim(),
      recipe: String(r[col.recipe] || "").trim(),
      qty: String(r[col.qty] || "").trim(),
      amount,
      date,
      status
    });
  }
  return out;
}

function makeFingerprint(row) {
  const day = row.date.toISOString().slice(0, 10);
  return [
    day,
    norm(row.name),
    phoneDigits(row.phone),
    norm(row.recipe),
    norm(row.qty),
    Number(row.amount).toFixed(2),
    row.status
  ].join("|");
}

async function getOrCreateCustomer(row) {
  const email = row.email || undefined;
  const phone = row.phone || undefined;
  const name = row.name;

  let customer = null;
  if (email) customer = await prisma.customer.findFirst({ where: { email } });
  if (!customer && phone) customer = await prisma.customer.findFirst({ where: { phone } });
  if (!customer) customer = await prisma.customer.findFirst({ where: { name } });
  if (customer) return customer;
  return prisma.customer.create({
    data: { name, email, phone }
  });
}

async function main() {
  const parsed = [];

  // Archived history
  parsed.push(
    ...parseRows(
      readSheet(files.jersey, "Complete"),
      {
        date: ["timestamp"],
        phone: ["phone number"],
        name: ["name"],
        email: ["email"],
        address: ["address"],
        recipe: ["base"],
        qty: ["amount of food"],
        amount: ["total price"]
      },
      OrderStatus.FULFILLED
    )
  );
  parsed.push(
    ...parseRows(
      readSheet(files.invoice, "2026Paid"),
      {
        date: ["date"],
        phone: ["phone number"],
        name: ["name"],
        email: ["email"],
        address: ["adress", "address"],
        recipe: ["recipe"],
        qty: ["amount"],
        amount: ["amount"]
      },
      OrderStatus.FULFILLED
    )
  );
  parsed.push(
    ...parseRows(
      readSheet(files.website, "Total order"),
      {
        date: ["date"],
        phone: ["phone number"],
        name: ["name"],
        email: ["email"],
        address: ["adress", "address"],
        recipe: ["recipe"],
        qty: ["amount"],
        amount: ["amount"]
      },
      OrderStatus.FULFILLED
    )
  );

  // Pending
  parsed.push(
    ...parseRows(
      readSheet(files.invoice, "Unpaid"),
      {
        date: ["date"],
        phone: ["phone number"],
        name: ["name"],
        email: ["email"],
        address: ["adress", "address"],
        recipe: ["recipe"],
        qty: ["amount"],
        amount: ["amount"]
      },
      OrderStatus.NEW
    )
  );
  parsed.push(
    ...parseRows(
      readSheet(files.website, "Pending"),
      {
        date: ["date"],
        phone: ["phone number"],
        name: ["name"],
        email: ["email"],
        address: ["adress", "address"],
        recipe: ["recipe"],
        qty: ["amount"],
        amount: ["amount"]
      },
      OrderStatus.NEW
    )
  );

  // De-dup within imported docs
  const byFp = new Map();
  for (const row of parsed) {
    const fp = makeFingerprint(row);
    if (!byFp.has(fp)) byFp.set(fp, row);
  }
  const merged = [...byFp.values()];

  // De-dup against existing by approximate same day/customer/amount/status.
  const existing = await prisma.order.findMany({
    include: { customer: true }
  });
  const existingFps = new Set(
    existing.map((o) => [
      o.createdAt.toISOString().slice(0, 10),
      norm(o.customer?.name),
      phoneDigits(o.customer?.phone),
      "",
      "",
      Number(o.subtotal || 0).toFixed(2),
      o.status
    ].join("|"))
  );

  let created = 0;
  let skippedExisting = 0;
  for (const row of merged) {
    const coarseFp = [
      row.date.toISOString().slice(0, 10),
      norm(row.name),
      phoneDigits(row.phone),
      "",
      "",
      Number(row.amount).toFixed(2),
      row.status
    ].join("|");
    if (existingFps.has(coarseFp)) {
      skippedExisting++;
      continue;
    }
    const customer = await getOrCreateCustomer(row);
    await prisma.order.create({
      data: {
        customerId: customer.id,
        subtotal: Number(row.amount),
        cogs: 0,
        margin: 0,
        status: row.status,
        createdAt: row.date
      }
    });
    created++;
  }

  const pendingCount = await prisma.order.count({ where: { status: { in: [OrderStatus.NEW, OrderStatus.CONFIRMED] } } });
  const archiveCount = await prisma.order.count({ where: { status: { in: [OrderStatus.FULFILLED, OrderStatus.CANCELLED] } } });

  console.log(
    JSON.stringify({
      parsed: parsed.length,
      mergedUnique: merged.length,
      created,
      skippedExisting,
      pendingCount,
      archiveCount
    })
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
