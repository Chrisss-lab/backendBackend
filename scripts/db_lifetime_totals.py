import sqlite3

import pandas as pd

from repo_paths import prisma_db


def main() -> None:
    db = prisma_db()
    con = sqlite3.connect(str(db))
    try:
        orders = pd.read_sql_query('select status, subtotal, cogs, margin, quantityLbs from "Order"', con)
        expenses = pd.read_sql_query("select amount from Expense", con)
    finally:
        con.close()

    for col in ["subtotal", "cogs", "margin", "quantityLbs"]:
        orders[col] = pd.to_numeric(orders[col], errors="coerce").fillna(0)
    expenses["amount"] = pd.to_numeric(expenses["amount"], errors="coerce").fillna(0)

    sales = float(orders["subtotal"].sum())
    cogs = float(orders["cogs"].sum())
    margin = float(orders["margin"].sum())
    lbs = float(orders["quantityLbs"].sum())
    expense_total = float(expenses["amount"].sum())

    print("orders:", len(orders))
    print("sales:", round(sales, 2))
    print("cogs:", round(cogs, 2))
    print("margin:", round(margin, 2))
    print("lbs:", round(lbs, 2))
    print("expenses:", round(expense_total, 2))
    print("sales-expenses:", round(sales - expense_total, 2))
    print("margin-expenses:", round(margin - expense_total, 2))
    print("\nstatus counts:")
    print(orders["status"].value_counts().to_string())


if __name__ == "__main__":
    main()
