import sqlite3
import uuid

import pandas as pd

from repo_paths import data_import_dir, prisma_db


def make_id() -> str:
    return f"dep_{uuid.uuid4().hex[:24]}"


def to_ms(v) -> int:
    ts = pd.to_datetime(v, errors="coerce")
    if pd.isna(ts):
        ts = pd.Timestamp.now()
    return int(ts.timestamp() * 1000)


def txt(v) -> str:
    return str(v or "").strip()


def main() -> None:
    db = prisma_db()
    wb = data_import_dir() / "Buisness Expenses.xlsx"
    if not wb.is_file():
        raise SystemExit(
            f"Missing {wb}\nCopy Buisness Expenses.xlsx into data/import/ then run again."
        )

    raw = pd.read_excel(wb, sheet_name="Depreciation", header=None)
    header_idx = raw.index[
        raw.apply(lambda r: r.astype(str).str.contains("Vendor/Payee", case=False, na=False).any(), axis=1)
    ][0]
    dep = raw.iloc[header_idx + 1 :].copy()
    dep.columns = [str(c).strip() for c in raw.iloc[header_idx].tolist()]
    dep = dep.dropna(how="all")
    dep["Amount"] = pd.to_numeric(dep["Amount"], errors="coerce").fillna(0.0).round(2)
    dep["Date"] = pd.to_datetime(dep["Date"], errors="coerce")

    con = sqlite3.connect(str(db))
    cur = con.cursor()
    cur.execute("PRAGMA foreign_keys = ON")

    inserted = 0
    skipped = 0

    try:
        cur.execute("BEGIN")
        for _, r in dep.iterrows():
            vendor = txt(r.get("Vendor/Payee")) or "Unknown"
            category = txt(r.get("Category")) or "Equipment"
            amount = float(r.get("Amount") or 0.0)
            expense_ms = to_ms(r.get("Date"))
            desc = txt(r.get("Description"))
            asset = txt(r.get("Asset Name"))
            method = txt(r.get("Depreciation Method"))
            section179 = txt(r.get("Section 179 Election"))
            cost = pd.to_numeric(r.get("Cost"), errors="coerce")
            cost_txt = "" if pd.isna(cost) else f"{float(cost):.2f}"
            notes = (
                f"[depreciation-import] {desc} | asset={asset} | method={method} | "
                f"section179={section179} | amount={amount:.2f} | cost={cost_txt}"
            )

            # Idempotent match by date+vendor+amount and depreciation tag in notes.
            exists = cur.execute(
                """
                SELECT id
                FROM Expense
                WHERE vendor = ?
                  AND category = ?
                  AND round(amount,2) = round(?,2)
                  AND expenseDate = ?
                  AND notes LIKE '%[depreciation-import]%'
                LIMIT 1
                """,
                (vendor, category, amount, expense_ms),
            ).fetchone()
            if exists:
                skipped += 1
                continue

            cur.execute(
                """
                INSERT INTO Expense (id, vendor, category, amount, expenseDate, receiptPath, notes, createdAt)
                VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
                """,
                (make_id(), vendor, category, amount, expense_ms, notes, int(pd.Timestamp.now().timestamp() * 1000)),
            )
            inserted += 1

        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()

    print(f"Inserted depreciation expense rows: {inserted}")
    print(f"Skipped existing depreciation rows: {skipped}")


if __name__ == "__main__":
    main()
