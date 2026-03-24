import sqlite3

import pandas as pd

from repo_paths import data_import_dir, prisma_db


def normalize_columns(cols):
    return [str(c).strip() for c in cols]


def parse_expenses_sheet(path: Path) -> pd.DataFrame:
    raw = pd.read_excel(path, sheet_name="Expenses", header=None)
    # Header row is the one containing "Date" and "Amount"
    header_idx = raw.index[raw.apply(lambda r: r.astype(str).str.contains("Date", case=False, na=False).any(), axis=1)][0]
    header = normalize_columns(raw.iloc[header_idx].tolist())
    data = raw.iloc[header_idx + 1 :].copy()
    data.columns = header
    data = data.dropna(how="all")
    if "Amount" in data.columns:
        data["Amount"] = pd.to_numeric(data["Amount"], errors="coerce")
    if "Date" in data.columns:
        data["Date"] = pd.to_datetime(data["Date"], errors="coerce")
    if "category" in data.columns:
        data["category"] = data["category"].astype(str).str.strip()
    return data


def parse_depreciation_sheet(path: Path) -> pd.DataFrame:
    raw = pd.read_excel(path, sheet_name="Depreciation", header=None)
    header_idx = raw.index[raw.apply(lambda r: r.astype(str).str.contains("Vendor/Payee", case=False, na=False).any(), axis=1)][0]
    header = normalize_columns(raw.iloc[header_idx].tolist())
    data = raw.iloc[header_idx + 1 :].copy()
    data.columns = header
    data = data.dropna(how="all")
    if "Amount" in data.columns:
        data["Amount"] = pd.to_numeric(data["Amount"], errors="coerce")
    if "Cost" in data.columns:
        data["Cost"] = pd.to_numeric(data["Cost"], errors="coerce")
    if "Date" in data.columns:
        data["Date"] = pd.to_datetime(data["Date"], errors="coerce")
    return data


def db_expenses_df(db_path: Path) -> pd.DataFrame:
    con = sqlite3.connect(str(db_path))
    try:
        df = pd.read_sql_query(
            "select id,vendor,category,amount,expenseDate,notes from Expense",
            con,
        )
    finally:
        con.close()
    df["amount"] = pd.to_numeric(df["amount"], errors="coerce")
    df["expenseDate"] = pd.to_datetime(df["expenseDate"], errors="coerce", unit="ms")
    return df


def main() -> None:
    workbook = data_import_dir() / "Buisness Expenses.xlsx"
    if not workbook.is_file():
        raise SystemExit(
            f"Missing {workbook}\nCopy Buisness Expenses.xlsx into data/import/ then run again."
        )
    db_path = prisma_db()

    exp = parse_expenses_sheet(workbook)
    dep = parse_depreciation_sheet(workbook)
    db = db_expenses_df(db_path)

    exp_total = float(exp["Amount"].sum())
    dep_total_amount_col = float(dep["Amount"].sum())
    dep_total_cost_col = float(dep["Cost"].sum())
    db_total = float(db["amount"].sum())

    print("Workbook expenses rows:", len(exp))
    print("Workbook expenses total (Amount):", round(exp_total, 2))
    print("Workbook depreciation rows:", len(dep))
    print("Workbook depreciation Amount total:", round(dep_total_amount_col, 2))
    print("Workbook depreciation Cost total:", round(dep_total_cost_col, 2))
    print("DB expense rows:", len(db))
    print("DB expense total:", round(db_total, 2))
    print("Gap vs workbook expenses only:", round(exp_total - db_total, 2))
    print("Gap vs expenses+depreciation(Amount):", round((exp_total + dep_total_amount_col) - db_total, 2))
    print("Gap vs expenses+depreciation(Cost):", round((exp_total + dep_total_cost_col) - db_total, 2))

    # Potential missing depreciation lines in DB by vendor/date/amount.
    dep_key = dep.copy()
    dep_key["date_key"] = dep_key["Date"].dt.date
    dep_key["vendor_key"] = dep_key["Vendor/Payee"].astype(str).str.strip().str.lower()
    dep_key["amt_key"] = dep_key["Amount"].round(2)

    db_key = db.copy()
    db_key["date_key"] = db_key["expenseDate"].dt.date
    db_key["vendor_key"] = db_key["vendor"].astype(str).str.strip().str.lower()
    db_key["amt_key"] = db_key["amount"].round(2)

    missing = dep_key.merge(
        db_key[["date_key", "vendor_key", "amt_key"]],
        on=["date_key", "vendor_key", "amt_key"],
        how="left",
        indicator=True,
    )
    missing = missing[missing["_merge"] == "left_only"]
    print("\nDepreciation rows missing from DB by (date,vendor,amount):", len(missing))
    if len(missing):
        cols = ["Date", "Vendor/Payee", "Description", "Category", "Amount", "Cost", "Asset Name"]
        cols = [c for c in cols if c in missing.columns]
        print(missing[cols].to_string(index=False))


if __name__ == "__main__":
    main()
