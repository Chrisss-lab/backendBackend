import numpy as np
import pandas as pd

from repo_paths import data_import_dir


def norm_phone(x: object) -> str:
    s = "".join(ch for ch in str(x or "") if ch.isdigit())
    return s[-10:] if len(s) >= 10 else s


def norm_text(x: object) -> str:
    s = str(x or "").strip().lower()
    return " ".join(s.split())


def to_num(x: object) -> float:
    try:
        return float(str(x).replace("$", "").replace(",", "").strip())
    except Exception:
        return np.nan


def main() -> None:
    imp = data_import_dir()
    j = imp / "Jersey Raw Orders.xlsx"
    w = imp / "webite .xlsx"
    if not j.is_file() or not w.is_file():
        raise SystemExit(
            f"Need both:\n  {j}\n  {w}\nCopy those workbooks into data/import/ then run again."
        )
    complete = pd.read_excel(j, sheet_name="Complete")
    total = pd.read_excel(w, sheet_name="Total order")

    c = pd.DataFrame(
        {
            "source": "complete",
            "date": pd.to_datetime(complete["Timestamp"], errors="coerce").dt.date,
            "name": complete["Name"],
            "phone": complete["Phone Number"].map(norm_phone),
            "email": complete["Email"].map(norm_text),
            "recipe": complete["Base"].map(norm_text),
            "lbs": complete["Amount of food"].map(to_num).round(2),
            "total": complete["Total Price"].map(to_num).round(2),
            "status": complete["Status"].map(norm_text),
        }
    )

    c = c[c["status"].isin(["up", "done", "complete"]) | c["status"].isna()]

    w = pd.DataFrame(
        {
            "source": "website_total_order",
            "date": pd.to_datetime(total["Date"], errors="coerce").dt.date,
            "name": total["Name"],
            "phone": total["Phone number"].map(norm_phone),
            "email": total["Email"].map(norm_text),
            "recipe": total["Recipe"].map(norm_text),
            "lbs": total["Amount "].map(to_num).round(2),
            "total": total["Amount"].map(to_num).round(2),
        }
    )

    all_df = pd.concat([c, w], ignore_index=True)
    all_df = all_df[all_df["date"].notna() & all_df["recipe"].ne("") & all_df["phone"].ne("")]

    all_df["key_exact"] = all_df.apply(
        lambda r: f"{r.phone}|{r.date}|{r.recipe}|{r.lbs:.2f}|{r.total:.2f}",
        axis=1,
    )
    exact_dups = all_df[all_df.duplicated("key_exact", keep=False)].sort_values(["key_exact", "source"])
    across = exact_dups.groupby("key_exact")["source"].nunique()
    across = across[across > 1]

    c2 = c[c["date"].notna() & c["phone"].ne("") & c["recipe"].ne("")].copy()
    w2 = w[w["date"].notna() & w["phone"].ne("") & w["recipe"].ne("")].copy()

    near = []
    for _, r in c2.iterrows():
        cand = w2[(w2["phone"] == r["phone"]) & (w2["recipe"] == r["recipe"]) & (w2["lbs"] == r["lbs"])]
        if cand.empty:
            continue
        dd = (pd.to_datetime(cand["date"]) - pd.to_datetime(r["date"])).dt.days.abs()
        td = (cand["total"] - r["total"]).abs()
        hit = cand[(dd <= 3) & (td <= 2.0)]
        for _, h in hit.iterrows():
            near.append(
                {
                    "phone": r["phone"],
                    "recipe": r["recipe"],
                    "lbs": r["lbs"],
                    "complete_date": r["date"],
                    "website_date": h["date"],
                    "day_diff": int(abs((pd.to_datetime(h["date"]) - pd.to_datetime(r["date"])).days)),
                    "complete_total": r["total"],
                    "website_total": h["total"],
                    "total_diff": float(abs(h["total"] - r["total"])),
                    "complete_name": r["name"],
                    "website_name": h["name"],
                }
            )

    near_df = pd.DataFrame(near).drop_duplicates()
    likely = near_df[near_df["total_diff"] <= 0.25] if not near_df.empty else near_df

    out1 = imp / "duplicate_exact_across_sources.csv"
    out2 = imp / "duplicate_near_across_sources.csv"
    out3 = imp / "duplicate_likely_across_sources.csv"

    if len(across):
        exact_dups[exact_dups["key_exact"].isin(set(across.index))].to_csv(out1, index=False)
    else:
        pd.DataFrame(columns=all_df.columns).to_csv(out1, index=False)
    near_df.sort_values(["day_diff", "total_diff"]).to_csv(out2, index=False)
    likely.sort_values(["day_diff", "total_diff"]).to_csv(out3, index=False)

    print("Rows considered:", len(all_df))
    print("Exact duplicate rows (any source):", len(exact_dups))
    print("Exact duplicate groups across BOTH sources:", len(across))
    print("Near-duplicate cross-source pairs (date<=3d,total diff<=2):", len(near_df))
    print("Likely near duplicates (total diff<=0.25):", len(likely))
    print("Wrote:", out1)
    print("Wrote:", out2)
    print("Wrote:", out3)
    if len(likely):
        print(likely.sort_values(["day_diff", "total_diff"]).head(15).to_string(index=False))


if __name__ == "__main__":
    main()
