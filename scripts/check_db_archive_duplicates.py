import sqlite3

import pandas as pd

from repo_paths import prisma_db


def main() -> None:
    db = prisma_db()
    con = sqlite3.connect(str(db))
    query = """
    select
      o.id,
      o.createdAt,
      o.status,
      o.quantityLbs,
      o.subtotal,
      c.name as customer,
      c.phone as phone,
      r.name as recipe
    from "Order" o
    left join Customer c on c.id = o.customerId
    left join Recipe r on r.id = o.recipeId
    """
    df = pd.read_sql_query(query, con)
    df["date"] = pd.to_datetime(df["createdAt"], errors="coerce").dt.date
    df["phone"] = df["phone"].fillna("").astype(str).str.replace(r"\D", "", regex=True).str[-10:]
    df["recipe"] = df["recipe"].fillna("").astype(str).str.strip().str.lower()
    df["lbs"] = pd.to_numeric(df["quantityLbs"], errors="coerce").round(2)
    df["total"] = pd.to_numeric(df["subtotal"], errors="coerce").round(2)
    arc = df[df["status"].isin(["FULFILLED", "CANCELLED"])].copy()
    arc["key"] = arc.apply(lambda r: f"{r.phone}|{r.date}|{r.recipe}|{r.lbs:.2f}|{r.total:.2f}", axis=1)
    dups = arc[arc.duplicated("key", keep=False)].sort_values(["key", "createdAt"])

    print("Archive rows:", len(arc))
    print("Archive exact-duplicate rows:", len(dups))
    print("Archive exact-duplicate groups:", dups["key"].nunique())
    if len(dups):
        print(dups[["id", "createdAt", "status", "customer", "phone", "recipe", "lbs", "total"]].to_string(index=False))


if __name__ == "__main__":
    main()
