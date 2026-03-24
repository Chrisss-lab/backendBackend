-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'CONFIRMED', 'FULFILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PromoKind" AS ENUM ('COUPON', 'COOP');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "id" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "foodType" TEXT NOT NULL DEFAULT 'Adult',
    "costPerPound" DECIMAL(65,30) NOT NULL,
    "salePrice" DECIMAL(65,30) NOT NULL,
    "chargeUnit" TEXT NOT NULL DEFAULT 'lb',
    "amountPerUnit" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "isBundle" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Uncategorized',
    "unit" TEXT NOT NULL,
    "quantityOnHand" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "pricePerLb" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "percentAdded" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "markupPercent" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "chargePerPound" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "defaultCost" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeIngredient" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeBundleItem" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "childRecipeId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "RecipeBundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLot" (
    "id" TEXT NOT NULL,
    "ingredient" TEXT NOT NULL,
    "quantityLbs" DECIMAL(65,30) NOT NULL,
    "unitCost" DECIMAL(65,30) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "PromoKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "discountPercent" DECIMAL(65,30),
    "discountFixed" DECIMAL(65,30),
    "kickbackPercent" DECIMAL(65,30),
    "kickbackFixed" DECIMAL(65,30),
    "payeeNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "customerId" TEXT NOT NULL,
    "recipeId" TEXT,
    "promoCodeId" TEXT,
    "promoCodeEntered" TEXT,
    "preTaxNet" DECIMAL(65,30),
    "promoDiscountPreTax" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "coOpKickbackOwed" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "quantityLbs" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "paymentMethod" TEXT,
    "paidAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "subtotal" DECIMAL(65,30) NOT NULL,
    "cogs" DECIMAL(65,30),
    "margin" DECIMAL(65,30),
    "productSummary" TEXT,
    "orderItemsJson" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL,
    "receiptPath" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "pdfPath" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "SyncEvent_sourceSystem_externalId_eventType_key" ON "SyncEvent"("sourceSystem", "externalId", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_externalId_key" ON "Customer"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_name_key" ON "Ingredient"("name");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeIngredient_recipeId_ingredientId_key" ON "RecipeIngredient"("recipeId", "ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeBundleItem_recipeId_childRecipeId_key" ON "RecipeBundleItem"("recipeId", "childRecipeId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Order_externalId_key" ON "Order"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_invoiceId_key" ON "Payment"("invoiceId");

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeBundleItem" ADD CONSTRAINT "RecipeBundleItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeBundleItem" ADD CONSTRAINT "RecipeBundleItem_childRecipeId_fkey" FOREIGN KEY ("childRecipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

