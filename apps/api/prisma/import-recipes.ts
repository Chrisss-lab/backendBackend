import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type RecipeInput = {
  name: string;
  costPerPound: number;
  salePrice: number;
  chargeUnit?: "lb" | "bag";
  amountPerUnit?: number;
  lines: Array<{ ingredient: string; ratio: number }>;
  bundle?: Array<{ recipe: string; quantity: number }>;
};

const rawRecipes: RecipeInput[] = [
  {
    name: "Daily Thrive",
    costPerPound: 0.87,
    salePrice: 4.25,
    lines: [
      { ingredient: "Chicken", ratio: 72 },
      { ingredient: "Chicken Gizzards", ratio: 14 },
      { ingredient: "Beef Liver", ratio: 4 },
      { ingredient: "Eggs", ratio: 3 },
      { ingredient: "Pumpkin", ratio: 2 },
      { ingredient: "Carrots", ratio: 1.5 },
      { ingredient: "Greek Yogurt", ratio: 2 },
      { ingredient: "Salmon oil", ratio: 0.75 },
      { ingredient: "Kelp Powder", ratio: 0.25 }
    ]
  },
  {
    name: "Fetch & Feast Chicken",
    costPerPound: 0.65,
    salePrice: 2.47,
    lines: [
      { ingredient: "Chicken", ratio: 81.08 },
      { ingredient: "Chicken Gizzards", ratio: 10.81 },
      { ingredient: "Pumpkin", ratio: 8.11 }
    ]
  },
  {
    name: "Growing Paws Puppy Blend",
    costPerPound: 0.95,
    salePrice: 2.99,
    lines: [
      { ingredient: "Chicken", ratio: 68 },
      { ingredient: "Chicken Gizzards", ratio: 7 },
      { ingredient: "Pumpkin", ratio: 1.75 },
      { ingredient: "Protein Powder", ratio: 1 },
      { ingredient: "Greek Yogurt", ratio: 3 },
      { ingredient: "Eggs", ratio: 10 },
      { ingredient: "Salmon oil", ratio: 1 },
      { ingredient: "Beef Liver", ratio: 3 },
      { ingredient: "Kelp Powder", ratio: 0.25 }
    ]
  },
  {
    name: "Royal Carnivore",
    costPerPound: 3.97,
    salePrice: 12.99,
    lines: [
      { ingredient: "Grass-fed beef", ratio: 0.34 },
      { ingredient: "Beef Heart", ratio: 0.25 },
      { ingredient: "Wild caught salmon", ratio: 5 },
      { ingredient: "Bone broth powder(grass fed)", ratio: 2 },
      { ingredient: "Calcium carbonate", ratio: 0.75 },
      { ingredient: "Chicken Gizzards", ratio: 16 },
      { ingredient: "Pumpkin", ratio: 6 },
      { ingredient: "Eggs", ratio: 6 },
      { ingredient: "Beef Liver", ratio: 5 },
      { ingredient: "Kelp powder, salmon oil", ratio: 0.25 }
    ]
  },
  {
    name: "Joint Care Blend",
    costPerPound: 1.82,
    salePrice: 5.25,
    lines: [
      { ingredient: "Chicken", ratio: 56 },
      { ingredient: "Beef Heart", ratio: 4 },
      { ingredient: "Bone broth powder(grass fed)", ratio: 6 },
      { ingredient: "Coconut Oil", ratio: 1 },
      { ingredient: "Greek Yogurt", ratio: 6 },
      { ingredient: "Salmon oil", ratio: 2 },
      { ingredient: "Pumpkin", ratio: 10 },
      { ingredient: "Carrots", ratio: 11 },
      { ingredient: "Beef Liver", ratio: 4 }
    ]
  },
  {
    name: "Ocean Vitality Blend",
    costPerPound: 2.27,
    salePrice: 9.99,
    lines: [
      { ingredient: "Tilapia", ratio: 80 },
      { ingredient: "Wild caught salmon", ratio: 5 },
      { ingredient: "Pumpkin", ratio: 3 },
      { ingredient: "Beef Liver", ratio: 3 },
      { ingredient: "Carrots", ratio: 6 },
      { ingredient: "Salmon oil", ratio: 1 }
    ]
  },
  {
    name: "Wild Whiskers (2oz) servings",
    costPerPound: 1.43,
    salePrice: 10.5,
    lines: [
      { ingredient: "Chicken", ratio: 70 },
      { ingredient: "Chicken Gizzards", ratio: 10 },
      { ingredient: "Beef Heart", ratio: 7 },
      { ingredient: "Beef Liver", ratio: 5 },
      { ingredient: "Wild caught salmon", ratio: 5 },
      { ingredient: "Eggs", ratio: 2 },
      { ingredient: "Salmon oil", ratio: 0.7 }
    ]
  },
  {
    name: "Wild Balance",
    costPerPound: 1.79,
    salePrice: 7.99,
    lines: [
      { ingredient: "Chicken", ratio: 50 },
      { ingredient: "Beef Heart", ratio: 10 },
      { ingredient: "Wild caught salmon", ratio: 5 },
      { ingredient: "Bone broth powder(grass fed)", ratio: 2 },
      { ingredient: "Eggs", ratio: 15 },
      { ingredient: "Chicken Gizzards", ratio: 5 },
      { ingredient: "Pumpkin", ratio: 6 },
      { ingredient: "Blueberries", ratio: 2 },
      { ingredient: "Beef Liver", ratio: 5 },
      { ingredient: "Kelp powder, salmon oil", ratio: 0.03 }
    ]
  },
  {
    name: "Puppy Thrive",
    costPerPound: 1.45,
    salePrice: 4.99,
    lines: [
      { ingredient: "Chicken", ratio: 0.7 },
      { ingredient: "Chicken Gizzards", ratio: 0.12 },
      { ingredient: "Goat Milk Powder", ratio: 0.05 },
      { ingredient: "Beef Liver", ratio: 0.03 },
      { ingredient: "Eggs", ratio: 0.03 },
      { ingredient: "Greek Yogurt", ratio: 0.03 },
      { ingredient: "Pumpkin", ratio: 0.02 },
      { ingredient: "Carrots", ratio: 0.015 },
      { ingredient: "Salmon oil", ratio: 0.0075 },
      { ingredient: "Kelp Powder", ratio: 0.0025 }
    ]
  },
  {
    name: "Bark & Broth Bites 1 4Oz bag",
    costPerPound: 1.34,
    salePrice: 23.96,
    chargeUnit: "bag",
    amountPerUnit: 0.25,
    lines: [
      { ingredient: "Chicken", ratio: 0.6 },
      { ingredient: "Beef Liver", ratio: 0.2 },
      { ingredient: "Eggs", ratio: 0.088 },
      { ingredient: "Gelatin", ratio: 0.038 },
      { ingredient: "Water", ratio: 0.075 }
    ]
  },
  {
    name: "Dehydrated Royal Carnivore",
    costPerPound: 3.97,
    salePrice: 24.99,
    lines: [
      { ingredient: "Grass-fed beef", ratio: 0.34 },
      { ingredient: "Beef Heart", ratio: 0.25 },
      { ingredient: "Wild caught salmon", ratio: 5 },
      { ingredient: "Bone broth powder(grass fed)", ratio: 2 },
      { ingredient: "Calcium carbonate", ratio: 0.75 },
      { ingredient: "Chicken Gizzards", ratio: 16 },
      { ingredient: "Pumpkin", ratio: 6 },
      { ingredient: "Eggs", ratio: 6 },
      { ingredient: "Beef Liver", ratio: 5 },
      { ingredient: "Kelp powder, salmon oil", ratio: 0.25 }
    ]
  },
  {
    name: "Natures Crunch",
    costPerPound: 1.51,
    salePrice: 8.99,
    lines: [
      { ingredient: "Bone less chicken", ratio: 0.62 },
      { ingredient: "Chicken Gizzards", ratio: 0.18 },
      { ingredient: "Beef Liver", ratio: 4 },
      { ingredient: "Eggs", ratio: 6 },
      { ingredient: "Pumpkin", ratio: 0.03 },
      { ingredient: "Carrots", ratio: 1.5 },
      { ingredient: "Greek Yogurt", ratio: 0.01 },
      { ingredient: "Salmon oil", ratio: 0.75 },
      { ingredient: "Kelp Powder", ratio: 0.25 },
      { ingredient: "Calcium carbonate", ratio: 0.75 }
    ]
  },
  {
    name: "Dehydrated Beef Liver Bites 1 4Oz bag",
    costPerPound: 2.8,
    salePrice: 12.99,
    chargeUnit: "bag",
    amountPerUnit: 0.25,
    lines: [{ ingredient: "Beef Liver", ratio: 100 }]
  },
  {
    name: "Dehydrated Beef Heart Bites 1 4Oz bag",
    costPerPound: 3.33,
    salePrice: 7.99,
    chargeUnit: "bag",
    amountPerUnit: 0.25,
    lines: [{ ingredient: "Beef Heart", ratio: 100 }]
  },
  {
    name: "Dog Flight(5Lb Plus Treats)",
    costPerPound: 11.07,
    salePrice: 35.99,
    chargeUnit: "bag",
    amountPerUnit: 1,
    lines: [],
    bundle: [
      { recipe: "Royal Carnivore", quantity: 1 },
      { recipe: "Wild Balance", quantity: 1 },
      { recipe: "Daily Thrive", quantity: 1 },
      { recipe: "Joint Care Blend", quantity: 1 },
      { recipe: "Ocean Vitality Blend", quantity: 1 },
      { recipe: "Bark & Broth Bites 1 4Oz bag", quantity: 1 }
    ]
  },
  {
    name: "Wild Whiskers (2oz) servings (Boneless Chicken)",
    costPerPound: 2.09,
    salePrice: 10.99,
    lines: [
      { ingredient: "Bone less chicken", ratio: 70 },
      { ingredient: "Chicken Gizzards", ratio: 10 },
      { ingredient: "Beef Heart", ratio: 7 },
      { ingredient: "Beef Liver", ratio: 5 },
      { ingredient: "Wild caught salmon", ratio: 5 },
      { ingredient: "Eggs", ratio: 2 },
      { ingredient: "Salmon oil", ratio: 0.002 },
      { ingredient: "Calcium carbonate", ratio: 0.005 }
    ]
  },
  {
    name: "Primal Pork",
    costPerPound: 1.56,
    salePrice: 5.99,
    lines: [
      { ingredient: "Pork", ratio: 0.685 },
      { ingredient: "Beef Liver", ratio: 0.03 },
      { ingredient: "Beef Heart", ratio: 0.04 },
      { ingredient: "Pumpkin", ratio: 0.05 },
      { ingredient: "Eggs", ratio: 0.1 },
      { ingredient: "Carrots", ratio: 0.08 },
      { ingredient: "Calcium carbonate", ratio: 0.75 },
      { ingredient: "Salmon oil", ratio: 0.005 },
      { ingredient: "Kelp Powder", ratio: 0.0025 }
    ]
  }
];

function normalizeRatio(value: number): number {
  if (value <= 1) return value * 100;
  return value;
}

async function upsertRecipe(recipe: RecipeInput) {
  const existing = await prisma.recipe.findFirst({ where: { name: recipe.name } });
  const record = existing
    ? await prisma.recipe.update({
        where: { id: existing.id },
        data: {
          costPerPound: recipe.costPerPound,
          salePrice: recipe.salePrice,
          chargeUnit: recipe.chargeUnit ?? "lb",
          amountPerUnit: recipe.amountPerUnit ?? 1,
          isBundle: Boolean(recipe.bundle?.length)
        }
      })
    : await prisma.recipe.create({
        data: {
          name: recipe.name,
          costPerPound: recipe.costPerPound,
          salePrice: recipe.salePrice,
          chargeUnit: recipe.chargeUnit ?? "lb",
          amountPerUnit: recipe.amountPerUnit ?? 1,
          isBundle: Boolean(recipe.bundle?.length)
        }
      });

  await prisma.recipeIngredient.deleteMany({ where: { recipeId: record.id } });
  await prisma.recipeBundleItem.deleteMany({ where: { recipeId: record.id } });

  for (const line of recipe.lines) {
    const ingredient = await prisma.ingredient.findUnique({ where: { name: line.ingredient } });
    if (!ingredient) continue;
    await prisma.recipeIngredient.create({
      data: {
        recipeId: record.id,
        ingredientId: ingredient.id,
        quantity: normalizeRatio(Number(line.ratio))
      }
    });
  }

  for (const line of recipe.bundle || []) {
    const child = await prisma.recipe.findFirst({ where: { name: line.recipe } });
    if (!child || child.id === record.id) continue;
    await prisma.recipeBundleItem.create({
      data: {
        recipeId: record.id,
        childRecipeId: child.id,
        quantity: line.quantity
      }
    });
  }
}

async function main() {
  for (const recipe of rawRecipes) {
    await upsertRecipe(recipe);
  }
  console.log(`Imported ${rawRecipes.length} recipes.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
