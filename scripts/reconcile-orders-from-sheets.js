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
    "[reconcile-orders-from-sheets] Missing data/import spreadsheets.\n" +
      "Copy workbooks into data/import/ if you need this one-off reconcile."
  );
  process.exit(1);
}

const norm = (v) => String(v || "").trim().toLowerCase();
const phoneDigits = (v) => String(v || "").replace(/\D+/g, "");
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toDate = (v) => {
  if (typeof v === "number") {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    return new Date(ms);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function readRows(filePath, sheetName) {
  const wb = xlsx.readFile(filePath);
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  return xlsx.utils.sheet_to_json(ws, { header: 1, defval: "" });
}

function parseJerseyComplete() {
  // Header row (index 0):
  // 1 Timestamp(date), 2 Name, 3 Phone, 4 Address, 5 Email, 6 Amount of food(lbs), 8?..., 22 Total Price(money)
  const rows = readRows(files.jersey, "Complete");
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => String(c || "").trim() !== "")) continue;
    const date = toDate(r[1]);
    const name = String(r[2] || "").trim();
    const phone = String(r[3] || "").trim();
    const address = String(r[4] || "").trim();
    const email = String(r[5] || "").trim();
    const lbs = toNum(r[6]);
    const money = toNum(r[22]);
    const profit = toNum(r[23]);
    if (!date || !name || money <= 0) continue;
    out.push({ date, name, phone, address, email, lbs, money, profit, status: OrderStatus.FULFILLED });
  }
  return out;
}

function parseInvoiceSheet(sheetName, status) {
  // Header: 1 Date, 2 Phone, 3 Name, 4 Email, 5 Address, 6 Recipe, 7 Amount(lbs), 10 Amount(money)
  const rows = readRows(files.invoice, sheetName);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => String(c || "").trim() !== "")) continue;
    const date = toDate(r[1]);
    const phone = String(r[2] || "").trim();
    const name = String(r[3] || "").trim();
    const email = String(r[4] || "").trim();
    const address = String(r[5] || "").trim();
    const lbs = toNum(r[7]);
    const money = toNum(r[10]);
    if (!date || !name || money <= 0) continue;
    out.push({ date, name, phone, address, email, lbs, money, profit: 0, status });
  }
  return out;
}

function parseWebsiteSheet(sheetName, status) {
  // Header: 0 Date, 1 Phone, 2 Name, 3 Email, 4 Address, 6 Amount(lbs), 9 Amount(money)
  const rows = readRows(files.website, sheetName);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => String(c || "").trim() !== "")) continue;
    const date = toDate(r[0]);
    const phone = String(r[1] || "").trim();
    const name = String(r[2] || "").trim();
    const email = String(r[3] || "").trim();
    const address = String(r[4] || "").trim();
    const lbs = toNum(r[6]);
    const money = toNum(r[9]);
    if (!date || !name || money <= 0) continue;
    out.push({ date, name, phone, address, email, lbs, money, profit: 0, status });
  }
  return out;
}

function fp(row) {
  return [
    row.date.toISOString().slice(0, 10),
    norm(row.name),
    phoneDigits(row.phone),
    Number(row.lbs || 0).toFixed(0), // lbs expected whole numbers
    Number(row.money || 0).toFixed(2),
    Number(row.profit || 0).toFixed(2),
    row.status
  ].join("|");
}

async function getOrCreateCustomer(row) {
  const email = row.email || undefined;
  const phone = row.phone || undefined;
  let c = null;
  if (email) c = await prisma.customer.findFirst({ where: { email } });
  if (!c && phone) c = await prisma.customer.findFirst({ where: { phone } });
  if (!c) c = await prisma.customer.findFirst({ where: { name: row.name } });
  if (c) return c;
  return prisma.customer.create({
    data: {
      name: row.name,
      email,
      phone
    }
  });
}

async function main() {
  const parsed = [
    ...parseJerseyComplete(),
    ...parseInvoiceSheet("2026Paid", OrderStatus.FULFILLED),
    ...parseInvoiceSheet("Unpaid", OrderStatus.NEW),
    ...parseWebsiteSheet("Total order", OrderStatus.FULFILLED),
    ...parseWebsiteSheet("Pending", OrderStatus.NEW)
  ];

  const map = new Map();
  for (const row of parsed) {
    const key = fp(row);
    if (!map.has(key)) map.set(key, row);
  }
  const merged = [...map.values()];

  await prisma.payment.deleteMany({});
  await prisma.invoice.deleteMany({});
  await prisma.order.deleteMany({});

  let created = 0;
  let pending = 0;
  let archived = 0;
  for (const row of merged) {
    const customer = await getOrCreateCustomer(row);
    await prisma.order.create({
      data: {
        customerId: customer.id,
        quantityLbs: row.lbs,
        paymentStatus: row.status === OrderStatus.FULFILLED ? "PAID" : "UNPAID",
        paymentMethod: row.status === OrderStatus.FULFILLED ? "Imported" : null,
        paidAt: row.status === OrderStatus.FULFILLED ? row.date : null,
        pickedUpAt: row.status === OrderStatus.FULFILLED ? row.date : null,
        subtotal: row.money, // money column
        cogs: row.profit > 0 ? row.money - row.profit : 0,
        margin: row.profit > 0 ? row.profit : 0,
        status: row.status,
        createdAt: row.date
      }
    });
    created++;
    if (row.status === OrderStatus.NEW || row.status === OrderStatus.CONFIRMED) pending++;
    else archived++;
  }

  console.log(
    JSON.stringify({
      parsed: parsed.length,
      mergedUnique: merged.length,
      created,
      pending,
      archived
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
