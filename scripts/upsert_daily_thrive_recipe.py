import shutil
import sqlite3
from datetime import datetime
from uuid import uuid4

from repo_paths import prisma_db

RECIPE_NAME = "Daily Thrive"
COST_PER_LB = 0.87
SALE_PRICE_PER_LB = 4.25

TARGET_LINES = [
    ("Chicken", 72.00),
    ("Chicken Gizzards", 14.00),
    ("Beef Liver", 4.00),
    ("Eggs", 3.00),
    ("Pumpkin", 2.00),
    ("Carrots", 1.50),
    ("Greek Yogurt", 2.00),
    ("Salmon oil", 0.75),
    ("Kelp Powder", 0.25),
]


def main() -> None:
    db_path = prisma_db()
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = db_path.with_name(f"{db_path.stem}.backup-before-daily-thrive-{stamp}{db_path.suffix}")
    shutil.copy2(db_path, backup_path)
    print(f"Backup created: {backup_path}")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    recipe = cur.execute('SELECT id, foodType FROM "Recipe" WHERE lower(name) = lower(?)', (RECIPE_NAME,)).fetchone()
    if recipe:
        recipe_id = recipe["id"]
        food_type = recipe["foodType"] or "Adult"
        cur.execute(
            'UPDATE "Recipe" SET name=?, "costPerPound"=?, "salePrice"=?, "chargeUnit"=?, "amountPerUnit"=?, "isBundle"=?, "foodType"=? WHERE id=?',
            (RECIPE_NAME, COST_PER_LB, SALE_PRICE_PER_LB, "lb", 1, 0, food_type, recipe_id),
        )
        print(f"Updated existing recipe: {RECIPE_NAME} ({recipe_id})")
    else:
        recipe_id = f"daily-thrive-{stamp}".replace("-", "")
        now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        cur.execute(
            'INSERT INTO "Recipe" (id, name, description, "foodType", "costPerPound", "salePrice", "chargeUnit", "amountPerUnit", "isBundle", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (recipe_id, RECIPE_NAME, None, "Adult", COST_PER_LB, SALE_PRICE_PER_LB, "lb", 1, 0, now),
        )
        print(f"Created recipe: {RECIPE_NAME} ({recipe_id})")

    ingredient_rows = cur.execute('SELECT id, name FROM "Ingredient"').fetchall()
    by_name = {str(r["name"]).strip().lower(): r["id"] for r in ingredient_rows}

    missing = [name for name, _ in TARGET_LINES if name.strip().lower() not in by_name]
    if missing:
        conn.rollback()
        conn.close()
        raise SystemExit(f"Missing ingredient(s): {', '.join(missing)}")

    cur.execute('DELETE FROM "RecipeIngredient" WHERE "recipeId" = ?', (recipe_id,))
    for ingredient_name, qty in TARGET_LINES:
        ingredient_id = by_name[ingredient_name.strip().lower()]
        cur.execute(
            'INSERT INTO "RecipeIngredient" (id, "recipeId", "ingredientId", quantity) VALUES (?, ?, ?, ?)',
            (f"ri{uuid4().hex}", recipe_id, ingredient_id, qty),
        )

    conn.commit()

    saved = cur.execute(
        """
        SELECT i.name AS ingredient_name, ri.quantity
        FROM "RecipeIngredient" ri
        JOIN "Ingredient" i ON i.id = ri."ingredientId"
        WHERE ri."recipeId" = ?
        ORDER BY i.name
        """,
        (recipe_id,),
    ).fetchall()
    conn.close()

    print("Saved Daily Thrive lines:")
    for row in saved:
        print(f"  {row['ingredient_name']}: {float(row['quantity']):.4f}%")


if __name__ == "__main__":
    main()
