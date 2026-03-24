"""
After a full dev.db copy to backup, remove transactional rows from the live SQLite DB.
Keeps: Customer, Recipe, Ingredient, RecipeIngredient, RecipeBundleItem, PromoCode,
      InventoryLot, User, SyncEvent (catalog / config).
Removes: Payment, Invoice, Order, Expense.
"""
import sqlite3
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: shell_live_database.py <path-to-dev.db>", file=sys.stderr)
        sys.exit(2)
    db = Path(sys.argv[1]).resolve()
    if not db.is_file():
        print(f"Database not found: {db}", file=sys.stderr)
        sys.exit(1)

    con = sqlite3.connect(str(db))
    try:
        con.execute("PRAGMA foreign_keys = OFF")
        cur = con.cursor()
        cur.execute("DELETE FROM Payment")
        p1 = cur.rowcount
        cur.execute("DELETE FROM Invoice")
        p2 = cur.rowcount
        cur.execute('DELETE FROM "Order"')
        p3 = cur.rowcount
        cur.execute("DELETE FROM Expense")
        p4 = cur.rowcount
        con.commit()
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("VACUUM")
        con.commit()
    finally:
        con.close()

    print(
        f"Shelled live DB: removed payments={p1}, invoices={p2}, orders={p3}, expenses={p4}. "
        "Recipes, ingredients, customers, promos kept."
    )


if __name__ == "__main__":
    main()
