import argparse
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path


def normalize_ratio_percent(value: float) -> float:
    # Rule from user:
    # - 0.25 means 0.25%
    # - 0.0025 means 0.25% (decimal fraction -> percent)
    if value > 0 and value < 0.01:
        return value * 100.0
    return value


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Normalize recipe ingredient ratio percents in SQLite."
    )
    parser.add_argument(
        "--db",
        default="apps/api/prisma/dev.db",
        help="Path to SQLite database file (default: apps/api/prisma/dev.db)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview updates without writing to database",
    )
    args = parser.parse_args()

    db_path = Path(args.db).resolve()
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    if not args.dry_run:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = db_path.with_name(f"{db_path.stem}.backup-before-ratio-normalize-{stamp}{db_path.suffix}")
        shutil.copy2(db_path, backup_path)
        print(f"Backup created: {backup_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    rows = cur.execute('SELECT id, quantity FROM "RecipeIngredient"').fetchall()
    updates = []
    for row in rows:
        raw = row["quantity"]
        try:
            qty = float(raw)
        except (TypeError, ValueError):
            continue
        next_qty = normalize_ratio_percent(qty)
        if abs(next_qty - qty) > 1e-12:
            updates.append((next_qty, row["id"], qty))

    print(f"Scanned rows: {len(rows)}")
    print(f"Rows to update: {len(updates)}")

    if updates:
        print("Sample changes (up to 20):")
        for next_qty, rid, old_qty in updates[:20]:
            print(f"  {rid}: {old_qty} -> {next_qty}")

    if args.dry_run:
        print("Dry run complete. No changes written.")
        conn.close()
        return

    cur.executemany('UPDATE "RecipeIngredient" SET quantity = ? WHERE id = ?', [(n, rid) for n, rid, _ in updates])
    conn.commit()
    conn.close()
    print(f"Updated rows: {len(updates)}")


if __name__ == "__main__":
    main()
