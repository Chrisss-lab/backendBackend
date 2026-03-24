import shutil
import sqlite3
import uuid

import pandas as pd

from repo_paths import data_import_dir, prisma_db


def ms_epoch(v) -> int:
    ts = pd.to_datetime(v, errors="coerce")
    if pd.isna(ts):
        ts = pd.Timestamp.now()
    return int(ts.timestamp() * 1000)


def txt(v) -> str | None:
    s = str(v or "").strip()
    return s or None


def num(v, default: float = 0.0) -> float:
    n = pd.to_numeric(v, errors="coerce")
    if pd.isna(n):
        return float(default)
    return float(n)


def phone_digits(v) -> str | None:
    d = "".join(ch for ch in str(v or "") if ch.isdigit())
    return d or None


def make_id() -> str:
    return f"sync_{uuid.uuid4().hex[:24]}"


def main() -> None:
    db = prisma_db()
    xlsx = data_import_dir() / "Jersey Raw Orders.xlsx"
    if not xlsx.is_file():
        raise SystemExit(
            f"Missing {xlsx}\nCopy Jersey Raw Orders.xlsx into data/import/ then run again."
        )

    backup = db.with_name(f"dev.backup-before-jersey-sync-{pd.Timestamp.now().strftime('%Y%m%d-%H%M%S')}.db")
    shutil.copy2(db, backup)
    print(f"Backup created: {backup}")

    src = pd.read_excel(xlsx, sheet_name="Complete")
    src = src.dropna(how="all")

    con = sqlite3.connect(str(db))
    cur = con.cursor()
    cur.execute("PRAGMA foreign_keys = ON")

    try:
        cur.execute("BEGIN")
        # Remove existing order graph only.
        cur.execute('DELETE FROM Payment WHERE invoiceId IN (SELECT id FROM Invoice)')
        cur.execute("DELETE FROM Invoice")
        cur.execute('DELETE FROM "Order"')

        inserted_customers = 0
        inserted_orders = 0

        # cache by phone/email/name to reduce duplicate customers
        customer_cache: dict[str, str] = {}

        for _, r in src.iterrows():
            name = txt(r.get("Name")) or "Unknown"
            email = txt(r.get("Email"))
            phone = phone_digits(r.get("Phone Number"))
            address = txt(r.get("Address"))
            notes_src = txt(r.get("Recommended New Ingredients")) or txt(r.get("Allergies"))
            base = txt(r.get("Base"))

            key = f"{(email or '').lower()}|{phone or ''}|{name.lower()}"
            customer_id = customer_cache.get(key)
            if not customer_id:
                existing = None
                if email:
                    existing = cur.execute("SELECT id FROM Customer WHERE lower(email)=lower(?) LIMIT 1", (email,)).fetchone()
                if (not existing) and phone:
                    existing = cur.execute(
                        "SELECT id FROM Customer WHERE replace(replace(replace(replace(ifnull(phone,''),'-',''),'(',''),')',''),' ','')=? LIMIT 1",
                        (phone,),
                    ).fetchone()
                if (not existing) and name:
                    existing = cur.execute("SELECT id FROM Customer WHERE lower(name)=lower(?) LIMIT 1", (name,)).fetchone()
                if existing:
                    customer_id = existing[0]
                else:
                    customer_id = make_id()
                    cur.execute(
                        "INSERT INTO Customer (id, externalId, name, email, phone, createdAt) VALUES (?, NULL, ?, ?, ?, ?)",
                        (customer_id, name, email, phone, ms_epoch(r.get("Timestamp"))),
                    )
                    inserted_customers += 1
                customer_cache[key] = customer_id

            subtotal = round(num(r.get("Total Price"), 0.0), 2)
            margin = round(num(r.get("Profit"), 0.0), 2)
            qty = round(num(r.get("Amount of food"), 0.0), 2)
            cogs = round(subtotal - margin, 2)

            status_raw = str(r.get("Status") or "").strip().lower()
            status = "CANCELLED" if "cancel" in status_raw else "FULFILLED"
            created_at_ms = ms_epoch(r.get("Timestamp"))
            paid_at_ms = created_at_ms if status == "FULFILLED" else None
            picked_up_at_ms = created_at_ms if status == "FULFILLED" else None
            payment_status = "PAID" if status == "FULFILLED" else "UNPAID"

            notes = txt(r.get("Meats"))
            if base:
                notes = f"{base}" if not notes else f"{base} | {notes}"
            if address:
                notes = f"{notes} | {address}" if notes else address
            if notes_src:
                notes = f"{notes} | {notes_src}" if notes else notes_src

            order_id = make_id()
            cur.execute(
                """
                INSERT INTO "Order" (
                  id, externalId, customerId, recipeId, promoCodeId, promoCodeEntered,
                  preTaxNet, promoDiscountPreTax, coOpKickbackOwed, status, quantityLbs,
                  paymentStatus, paymentMethod, paidAt, pickedUpAt, subtotal, cogs, margin, notes, createdAt
                ) VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    order_id,
                    customer_id,
                    status,
                    qty,
                    payment_status,
                    paid_at_ms,
                    picked_up_at_ms,
                    subtotal,
                    cogs,
                    margin,
                    notes,
                    created_at_ms,
                ),
            )
            inserted_orders += 1

        con.commit()
        print(f"Inserted orders: {inserted_orders}")
        print(f"Inserted new customers: {inserted_customers}")
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


if __name__ == "__main__":
    main()
