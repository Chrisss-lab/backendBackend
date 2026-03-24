import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type IngredientSeed = {
  name: string;
  category: string;
  quantityOnHand: number;
  totalCost: number;
  percentAdded: number;
  chargePerPound: number;
  unit?: string;
};

type RecipeLine = { ingredient: string; ratio: number };
type RecipeSeed = {
  name: string;
  costPerPound: number;
  salePrice: number;
  description?: string;
  lines: RecipeLine[];
};

const ingredients: IngredientSeed[] = [
  { name: "Chicken", category: "Meats", quantityOnHand: 40, totalCost: 23.2, percentAdded: 20, chargePerPound: 2.5 },
  { name: "Chicken Gizzards", category: "Meats", quantityOnHand: 40, totalCost: 41.6, percentAdded: 10, chargePerPound: 2.25 },
  { name: "Beef", category: "Meats", quantityOnHand: 1, totalCost: 3.6, percentAdded: 10, chargePerPound: 8 },
  { name: "Tilapia", category: "Meats", quantityOnHand: 1, totalCost: 1.96, percentAdded: 5, chargePerPound: 6 },
  { name: "Eggs", category: "Meats", quantityOnHand: 10, totalCost: 14.7, percentAdded: 2, chargePerPound: 3 },
  { name: "Wild caught salmon", category: "Meats", quantityOnHand: 1, totalCost: 10, percentAdded: 4, chargePerPound: 12 },
  { name: "Pork", category: "Meats", quantityOnHand: 1, totalCost: 1.46, percentAdded: 10, chargePerPound: 6 },
  { name: "Grass-fed beef", category: "Meats", quantityOnHand: 8, totalCost: 46.92, percentAdded: 10, chargePerPound: 12 },
  { name: "Chicken bones", category: "Meats", quantityOnHand: 1, totalCost: 0.7, percentAdded: 10, chargePerPound: 2.6 },
  { name: "Duck", category: "Meats", quantityOnHand: 1, totalCost: 6.72, percentAdded: 10, chargePerPound: 12 },
  { name: "Soul", category: "Meats", quantityOnHand: 1, totalCost: 4.46, percentAdded: 10, chargePerPound: 8 },
  { name: "Sardines", category: "Meats", quantityOnHand: 1, totalCost: 4.32, percentAdded: 1, chargePerPound: 20 },
  { name: "Calcium shells", category: "Meats", quantityOnHand: 5, totalCost: 9, percentAdded: 0.2, chargePerPound: 40 },
  { name: "Bone broth powder(grass fed)", category: "Meats", quantityOnHand: 2, totalCost: 28.99, percentAdded: 1, chargePerPound: 32 },
  { name: "Kelp powder, salmon oil", category: "Meats", quantityOnHand: 13.6, totalCost: 73.94, percentAdded: 1, chargePerPound: 40 },
  { name: "Bone less chicken", category: "Meats", quantityOnHand: 1, totalCost: 1.54, percentAdded: 0, chargePerPound: 0 },

  { name: "Beef Liver", category: "Organs", quantityOnHand: 28, totalCost: 63.11, percentAdded: 4, chargePerPound: 2.65 },
  { name: "Beef Heart", category: "Organs", quantityOnHand: 60, totalCost: 200, percentAdded: 10, chargePerPound: 7 },
  { name: "Tripe", category: "Organs", quantityOnHand: 10, totalCost: 40, percentAdded: 2, chargePerPound: 8 },

  { name: "Cottage Cheese", category: "Dairy", quantityOnHand: 2, totalCost: 5.26, percentAdded: 4, chargePerPound: 6.25 },
  { name: "Milk", category: "Dairy", quantityOnHand: 1, totalCost: 0.26, percentAdded: 4, chargePerPound: 0.7 },
  { name: "Protein Powder", category: "Dairy", quantityOnHand: 10, totalCost: 65.09, percentAdded: 1, chargePerPound: 12 },
  { name: "Greek Yogurt", category: "Dairy", quantityOnHand: 11, totalCost: 30.74, percentAdded: 4, chargePerPound: 4 },
  { name: "Kefir", category: "Dairy", quantityOnHand: 2.15, totalCost: 3.07, percentAdded: 2, chargePerPound: 8 },
  { name: "Goat Milk Powder", category: "Dairy", quantityOnHand: 5, totalCost: 68, percentAdded: 0.01, chargePerPound: 20 },

  { name: "Blueberries", category: "Fruits/Veggies", quantityOnHand: 1, totalCost: 2.61, percentAdded: 4, chargePerPound: 7 },
  { name: "Pumpkin", category: "Fruits/Veggies", quantityOnHand: 10, totalCost: 8.9, percentAdded: 5, chargePerPound: 4 },
  { name: "Carrots", category: "Fruits/Veggies", quantityOnHand: 25, totalCost: 18.31, percentAdded: 10, chargePerPound: 4.5 },
  { name: "Kelp Powder", category: "Fruits/Veggies", quantityOnHand: 1, totalCost: 14.99, percentAdded: 0.001, chargePerPound: 40 },
  { name: "Beet Pulp", category: "Fruits/Veggies", quantityOnHand: 5, totalCost: 25, percentAdded: 0.002, chargePerPound: 14 },
  { name: "Sweet potato", category: "Fruits/Veggies", quantityOnHand: 1, totalCost: 1.5, percentAdded: 0.02, chargePerPound: 4.5 },
  { name: "Local raw honey (Nj)", category: "Fruits/Veggies", quantityOnHand: 2, totalCost: 42, percentAdded: 0.002, chargePerPound: 65 },
  { name: "Organic Raw Apple cider vinegar", category: "Fruits/Veggies", quantityOnHand: 1, totalCost: 4.64, percentAdded: 0.0075, chargePerPound: 15 },
  { name: "Organic Sauerkraut", category: "Fruits/Veggies", quantityOnHand: 1, totalCost: 10, percentAdded: 0.01, chargePerPound: 20 },
  { name: "Broccoli", category: "Fruits/Veggies", quantityOnHand: 1, totalCost: 2, percentAdded: 0.01, chargePerPound: 6 },
  { name: "Cabbage", category: "Fruits/Veggies", quantityOnHand: 1, totalCost: 1.75, percentAdded: 0.01, chargePerPound: 6 },
  { name: "Water", category: "Fruits/Veggies", quantityOnHand: 1, totalCost: 0, percentAdded: 0, chargePerPound: 0 },
  { name: "Calcium carbonate", category: "Fruits/Veggies", quantityOnHand: 8, totalCost: 38, percentAdded: 0, chargePerPound: 0 },

  { name: "Coconut Oil", category: "Fats", quantityOnHand: 35, totalCost: 92.53, percentAdded: 2, chargePerPound: 7 },
  { name: "Salmon oil", category: "Fats", quantityOnHand: 7.6, totalCost: 49.95, percentAdded: 0.4, chargePerPound: 48 },
  { name: "Cod Liver Oil", category: "Fats", quantityOnHand: 1, totalCost: 25, percentAdded: 0.2, chargePerPound: 50 },
  { name: "Grass feed Beef Tallow", category: "Fats", quantityOnHand: 50, totalCost: 170, percentAdded: 5, chargePerPound: 6 },
  { name: "Pork fat", category: "Fats", quantityOnHand: 38.5, totalCost: 40.45, percentAdded: 5, chargePerPound: 4.7 },
  { name: "Gelatin", category: "Fats", quantityOnHand: 1, totalCost: 11, percentAdded: 0, chargePerPound: 0 }
];

const recipes: RecipeSeed[] = [
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
  }
];

async function seedIngredients() {
  for (const item of ingredients) {
    const qty = Number(item.quantityOnHand || 0);
    const totalCost = Number(item.totalCost || 0);
    const pricePerLb = qty > 0 ? totalCost / qty : 0;
    const chargePerPound = Number(item.chargePerPound || 0);
    const markupPercent = pricePerLb > 0 ? ((chargePerPound - pricePerLb) / pricePerLb) * 100 : 0;

    await prisma.ingredient.upsert({
      where: { name: item.name },
      update: {
        category: item.category,
        unit: item.unit ?? "lb",
        quantityOnHand: qty,
        totalCost,
        pricePerLb,
        percentAdded: Number(item.percentAdded || 0),
        markupPercent,
        chargePerPound,
        defaultCost: pricePerLb
      },
      create: {
        name: item.name,
        category: item.category,
        unit: item.unit ?? "lb",
        quantityOnHand: qty,
        totalCost,
        pricePerLb,
        percentAdded: Number(item.percentAdded || 0),
        markupPercent,
        chargePerPound,
        defaultCost: pricePerLb
      }
    });
  }
}

async function seedRecipes() {
  for (const recipe of recipes) {
    const existing = await prisma.recipe.findFirst({ where: { name: recipe.name } });
    const recipeRecord = existing
      ? await prisma.recipe.update({
          where: { id: existing.id },
          data: {
            description: recipe.description,
            costPerPound: recipe.costPerPound,
            salePrice: recipe.salePrice
          }
        })
      : await prisma.recipe.create({
          data: {
            name: recipe.name,
            description: recipe.description,
            costPerPound: recipe.costPerPound,
            salePrice: recipe.salePrice
          }
        });

    await prisma.recipeIngredient.deleteMany({ where: { recipeId: recipeRecord.id } });

    for (const line of recipe.lines) {
      const ingredient = await prisma.ingredient.findUnique({ where: { name: line.ingredient } });
      if (!ingredient) continue;
      await prisma.recipeIngredient.create({
        data: {
          recipeId: recipeRecord.id,
          ingredientId: ingredient.id,
          quantity: line.ratio
        }
      });
    }
  }
}

async function main() {
  await seedIngredients();
  await seedRecipes();
  console.log(`Seed complete: ${ingredients.length} ingredients, ${recipes.length} recipes.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
