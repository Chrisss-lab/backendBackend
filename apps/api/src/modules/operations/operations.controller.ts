import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, UploadedFile, UseInterceptors } from "@nestjs/common";
import { OrderStatus, PromoKind } from "@prisma/client";
import { FileInterceptor } from "@nestjs/platform-express";
import { IsBoolean, IsEnum, IsIn, IsNumber, IsOptional, IsString } from "class-validator";
import { memoryStorage } from "multer";
import { OperationsService } from "./operations.service";

class CustomerDto {
  @IsString()
  name!: string;
  @IsOptional()
  @IsString()
  email?: string;
  @IsOptional()
  @IsString()
  phone?: string;
}

class CustomerUpdateDto {
  @IsString()
  name!: string;
  @IsOptional()
  @IsString()
  email?: string;
  @IsOptional()
  @IsString()
  phone?: string;
}

class IngredientDto {
  @IsString()
  name!: string;
  @IsString()
  category!: string;
  @IsString()
  unit!: string;
  @IsNumber()
  quantityOnHand!: number;
  @IsNumber()
  totalCost!: number;
  @IsNumber()
  percentAdded!: number;
  @IsNumber()
  chargePerPound!: number;
}

class IngredientPurchaseDto {
  @IsString()
  ingredientId!: string;
  @IsNumber()
  addedQuantity!: number;
  @IsNumber()
  addedCost!: number;
}

class IngredientAdjustDto {
  @IsString()
  ingredientId!: string;
  @IsNumber()
  quantityDelta!: number;
}

class IngredientPricingDto {
  @IsString()
  ingredientId!: string;
  @IsOptional()
  @IsString()
  category?: string;
  @IsNumber()
  percentAdded!: number;
  @IsNumber()
  chargePerPound!: number;
}

class IngredientCoreUpdateDto {
  @IsString()
  ingredientId!: string;
  @IsNumber()
  quantityOnHand!: number;
  @IsNumber()
  totalCost!: number;
  @IsNumber()
  chargePerPound!: number;
  @IsOptional()
  @IsNumber()
  percentAdded?: number;
  @IsOptional()
  @IsString()
  category?: string;
}

class ExpenseDto {
  @IsString()
  vendor!: string;
  @IsString()
  category!: string;
  @IsNumber()
  amount!: number;
  @IsString()
  expenseDate!: string;
  @IsOptional()
  @IsString()
  receiptPath?: string;
  @IsOptional()
  @IsString()
  notes?: string;
}

class ExpenseRecategorizeDto {
  @IsString()
  expenseId!: string;
  @IsString()
  category!: string;
}

class ExpenseUpdateDto {
  @IsString()
  vendor!: string;
  @IsString()
  category!: string;
  @IsNumber()
  amount!: number;
  @IsString()
  expenseDate!: string;
  @IsOptional()
  @IsString()
  receiptPath?: string;
  @IsOptional()
  @IsString()
  notes?: string;
}

class ExpenseImportRowDto {
  @IsString()
  expenseDate!: string;
  @IsString()
  vendor!: string;
  @IsOptional()
  @IsString()
  description?: string;
  @IsString()
  category!: string;
  @IsNumber()
  amount!: number;
  @IsOptional()
  @IsString()
  payment?: string;
  @IsOptional()
  @IsString()
  receipt?: string;
}

class ExpenseBulkImportDto {
  rows!: ExpenseImportRowDto[];
}

class RecipeDto {
  @IsString()
  name!: string;
  @IsOptional()
  @IsString()
  description?: string;
  @IsOptional()
  @IsString()
  foodType?: string;
  @IsNumber()
  costPerPound!: number;
  @IsNumber()
  salePrice!: number;
  @IsOptional()
  @IsString()
  @IsIn(["lb", "bag"])
  chargeUnit?: string;
  @IsOptional()
  @IsNumber()
  amountPerUnit?: number;
}

class RecipeLineDto {
  @IsString()
  ingredientId!: string;
  @IsNumber()
  quantity!: number;
}

class RecipeFullDto {
  @IsString()
  name!: string;
  @IsOptional()
  @IsString()
  description?: string;
  @IsOptional()
  @IsString()
  foodType?: string;
  @IsNumber()
  costPerPound!: number;
  @IsNumber()
  salePrice!: number;
  @IsOptional()
  @IsString()
  @IsIn(["lb", "bag"])
  chargeUnit?: string;
  @IsOptional()
  @IsNumber()
  amountPerUnit?: number;
  @IsOptional()
  @IsBoolean()
  isBundle?: boolean;
  ingredients!: RecipeLineDto[];
  bundleItems?: RecipeLineDto[];
}

class RecipeIngredientDto {
  @IsString()
  recipeId!: string;
  @IsString()
  ingredientId!: string;
  @IsNumber()
  quantity!: number;
}

class InventoryDto {
  @IsString()
  ingredient!: string;
  @IsNumber()
  quantityLbs!: number;
  @IsNumber()
  unitCost!: number;
  @IsString()
  receivedAt!: string;
}

class MakeRecipeDto {
  @IsString()
  recipeId!: string;
  @IsNumber()
  batchLbs!: number;
}

class OrderDto {
  @IsString()
  customerId!: string;
  @IsOptional()
  @IsNumber()
  quantityLbs?: number;
  @IsOptional()
  @IsString()
  paymentMethod?: string;
  @IsNumber()
  subtotal!: number;
  @IsOptional()
  @IsNumber()
  cogs?: number;
  @IsOptional()
  @IsNumber()
  margin?: number;
  @IsOptional()
  @IsIn(["NEW", "CONFIRMED", "FULFILLED", "CANCELLED"])
  status?: OrderStatus;
  @IsOptional()
  @IsString()
  notes?: string;
  /** When set, server recomputes pricing, coupons, and co-op kickback from recipe + qty (recommended for Submit Order). */
  @IsOptional()
  @IsString()
  recipeId?: string;
  @IsOptional()
  @IsString()
  promoCode?: string;
  @IsOptional()
  items?: Array<{ recipeId: string; quantityLbs: number }>;
}

class CreatePromoCodeDto {
  @IsString()
  code!: string;
  @IsString()
  label!: string;
  @IsEnum(PromoKind)
  kind!: PromoKind;
  @IsOptional()
  @IsBoolean()
  active?: boolean;
  @IsOptional()
  @IsNumber()
  discountPercent?: number | null;
  @IsOptional()
  @IsNumber()
  discountFixed?: number | null;
  @IsOptional()
  @IsNumber()
  kickbackPercent?: number | null;
  @IsOptional()
  @IsNumber()
  kickbackFixed?: number | null;
  @IsOptional()
  @IsString()
  payeeNotes?: string | null;
}

class UpdatePromoCodeDto {
  @IsOptional()
  @IsString()
  label?: string;
  @IsOptional()
  @IsBoolean()
  active?: boolean;
  @IsOptional()
  @IsNumber()
  discountPercent?: number | null;
  @IsOptional()
  @IsNumber()
  discountFixed?: number | null;
  @IsOptional()
  @IsNumber()
  kickbackPercent?: number | null;
  @IsOptional()
  @IsNumber()
  kickbackFixed?: number | null;
  @IsOptional()
  @IsString()
  payeeNotes?: string | null;
}

class OrderStatusDto {
  @IsIn(["NEW", "CONFIRMED", "FULFILLED", "CANCELLED"])
  status!: OrderStatus;
}

class OrderUpdateDto {
  @IsOptional()
  @IsNumber()
  quantityLbs?: number;
  @IsOptional()
  @IsNumber()
  subtotal?: number;
  @IsOptional()
  @IsNumber()
  cogs?: number;
  @IsOptional()
  @IsNumber()
  margin?: number;
  @IsOptional()
  @IsString()
  notes?: string;
}

class OrderItemLineDto {
  @IsString()
  recipeId!: string;
  @IsNumber()
  quantityLbs!: number;
}

class OrderItemsUpdateDto {
  items!: OrderItemLineDto[];
  @IsOptional()
  @IsString()
  notes?: string;
}

class OrderProgressDto {
  @IsOptional()
  @IsBoolean()
  paid?: boolean;
  @IsOptional()
  @IsString()
  paymentMethod?: string;
  @IsOptional()
  @IsBoolean()
  pickedUp?: boolean;
}

class OrderPartialPaymentDto {
  @IsNumber()
  amount!: number;
  @IsString()
  paymentMethod!: string;
}

class InvoiceDto {
  @IsString()
  orderId!: string;
  @IsString()
  invoiceNumber!: string;
  @IsNumber()
  amount!: number;
}

class MarkPaidDto {
  @IsString()
  invoiceId!: string;
  @IsNumber()
  amount!: number;
  @IsOptional()
  @IsString()
  status?: string;
}

@Controller("operations")
export class OperationsController {
  constructor(private readonly ops: OperationsService) {}

  @Get("overview")
  overview() {
    return this.ops.getOverview();
  }

  @Get("dashboard")
  listDashboard() {
    return this.ops.listDashboard();
  }

  /** JR Workers folder / single .ics — read-only feed for the web Calendar tab */
  @Get("calendar/workers-ics")
  workersIcsCalendar() {
    return this.ops.getWorkersIcsCalendar();
  }

  @Get("customers")
  listCustomers() {
    return this.ops.listCustomers();
  }

  @Post("customers")
  createCustomer(@Body() dto: CustomerDto) {
    return this.ops.createCustomer(dto);
  }

  @Put("customers/:id")
  updateCustomer(@Param("id") id: string, @Body() dto: CustomerUpdateDto) {
    return this.ops.updateCustomer(id, dto);
  }

  @Get("ingredients")
  listIngredients() {
    return this.ops.listIngredients();
  }

  @Post("ingredients")
  createIngredient(@Body() dto: IngredientDto) {
    return this.ops.createIngredient(dto);
  }

  @Post("ingredients/purchase")
  purchaseIngredient(@Body() dto: IngredientPurchaseDto) {
    return this.ops.purchaseIngredient(dto);
  }

  @Post("ingredients/adjust")
  adjustIngredient(@Body() dto: IngredientAdjustDto) {
    return this.ops.adjustIngredientQuantity(dto);
  }

  @Post("ingredients/pricing")
  updateIngredientPricing(@Body() dto: IngredientPricingDto) {
    return this.ops.updateIngredientPricing(dto);
  }

  @Post("ingredients/update-core")
  updateIngredientCore(@Body() dto: IngredientCoreUpdateDto) {
    return this.ops.updateIngredientCore(dto);
  }

  @Get("recipes")
  listRecipes() {
    return this.ops.listRecipes();
  }

  @Post("expenses")
  createExpense(@Body() dto: ExpenseDto) {
    return this.ops.createExpense(dto);
  }

  @Post("expenses/upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }
    })
  )
  uploadExpenseReceipt(@UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException("No file uploaded.");
    return this.ops.saveExpenseReceiptUpload(file);
  }

  @Get("expenses")
  listExpenses() {
    return this.ops.listExpenses();
  }

  @Post("expenses/recategorize")
  recategorizeExpense(@Body() dto: ExpenseRecategorizeDto) {
    return this.ops.recategorizeExpense(dto);
  }

  @Put("expenses/:id")
  updateExpense(@Param("id") id: string, @Body() dto: ExpenseUpdateDto) {
    return this.ops.updateExpense(id, dto);
  }

  @Post("expenses/bulk-import")
  bulkImportExpenses(@Body() dto: ExpenseBulkImportDto) {
    return this.ops.bulkImportExpenses(dto.rows || []);
  }

  @Post("expenses/normalize-categories")
  normalizeExpenseCategories() {
    return this.ops.normalizeAllExpenseCategories();
  }

  @Post("recipes")
  createRecipe(@Body() dto: RecipeDto) {
    return this.ops.createRecipe(dto);
  }

  @Post("recipes/full")
  createRecipeFull(@Body() dto: RecipeFullDto) {
    return this.ops.createRecipeWithIngredients(dto);
  }

  @Put("recipes/:id/full")
  updateRecipeFull(@Param("id") id: string, @Body() dto: RecipeFullDto) {
    return this.ops.updateRecipeWithIngredients(id, dto);
  }

  @Delete("recipes/:id")
  deleteRecipe(@Param("id") id: string) {
    return this.ops.deleteRecipe(id);
  }

  @Post("recipe-ingredients")
  addRecipeIngredient(@Body() dto: RecipeIngredientDto) {
    return this.ops.addRecipeIngredient(dto);
  }

  @Get("inventory")
  listInventory() {
    return this.ops.listInventory();
  }

  @Post("inventory")
  createInventory(@Body() dto: InventoryDto) {
    return this.ops.createInventoryLot(dto);
  }

  @Post("making")
  makeRecipe(@Body() dto: MakeRecipeDto) {
    return this.ops.makeRecipeBatch(dto);
  }

  @Get("orders")
  listOrders() {
    return this.ops.listOrders();
  }

  @Get("promo-codes")
  listPromoCodes() {
    return this.ops.listPromoCodes();
  }

  @Get("promo-codes/coop-summary")
  coopKickbackSummary() {
    return this.ops.getCoopKickbackSummary();
  }

  @Post("promo-codes")
  createPromoCode(@Body() dto: CreatePromoCodeDto) {
    return this.ops.createPromoCode(dto);
  }

  @Put("promo-codes/:id")
  updatePromoCode(@Param("id") id: string, @Body() dto: UpdatePromoCodeDto) {
    return this.ops.updatePromoCode(id, dto);
  }

  @Post("orders")
  createOrder(@Body() dto: OrderDto) {
    return this.ops.createOrder(dto);
  }

  @Put("orders/:id/status")
  updateOrderStatus(@Param("id") id: string, @Body() dto: OrderStatusDto) {
    return this.ops.updateOrderStatus({ orderId: id, status: dto.status });
  }

  @Put("orders/:id")
  updateOrder(@Param("id") id: string, @Body() dto: OrderUpdateDto) {
    return this.ops.updateOrder(id, dto);
  }

  @Put("orders/:id/items")
  updateOrderItems(@Param("id") id: string, @Body() dto: OrderItemsUpdateDto) {
    return this.ops.updateOrderItems(id, dto);
  }

  @Put("orders/:id/progress")
  updateOrderProgress(@Param("id") id: string, @Body() dto: OrderProgressDto) {
    return this.ops.updateOrderProgress({ orderId: id, ...dto });
  }

  @Put("orders/:id/partial-payment")
  applyOrderPartialPayment(@Param("id") id: string, @Body() dto: OrderPartialPaymentDto) {
    return this.ops.applyOrderPartialPayment({ orderId: id, amount: dto.amount, paymentMethod: dto.paymentMethod });
  }

  @Delete("orders/:id")
  deleteOrder(@Param("id") id: string) {
    return this.ops.deleteOrderCascade(id);
  }

  @Get("invoices")
  listInvoices() {
    return this.ops.listInvoices();
  }

  /** Static sample PDF (same generator as real invoices) — open `url` in the browser. */
  @Get("invoices/demo-sample")
  demoInvoiceInfo() {
    return {
      url: "/uploads/invoices/DEMO-sample-invoice.pdf",
      fileName: "DEMO-sample-invoice.pdf",
      note: "Regenerated when the API starts. Shows layout, tax, and payment blocks."
    };
  }

  @Post("invoices")
  createInvoice(@Body() dto: InvoiceDto) {
    return this.ops.createInvoice(dto);
  }

  /** Create invoice + PDF for every pending order that does not have one yet (Invoice tab defaults). */
  @Post("invoices/sync-pending")
  syncPendingInvoices() {
    return this.ops.syncPendingOrderInvoices();
  }

  /** Backfill invoice + PDF for fulfilled/cancelled orders missing them (same logic as pending sync). */
  @Post("invoices/sync-archive")
  syncArchiveInvoices() {
    return this.ops.syncArchiveOrderInvoices();
  }

  /** Rewrite every existing invoice PDF (current template + logo in `Backend/Invoices/`). */
  @Post("invoices/regenerate-all")
  regenerateAllInvoices() {
    return this.ops.regenerateAllInvoicePdfs();
  }

  /** Pending + archive sync (missing invoices/PDFs) then regenerate every invoice PDF. */
  @Post("invoices/sync-all-and-regenerate")
  syncAllOrdersAndRegenerateInvoices() {
    return this.ops.syncPendingArchiveAndRegenerateAllInvoices();
  }

  @Post("invoices/from-pending-order/:orderId")
  invoiceFromPendingOrder(@Param("orderId") orderId: string) {
    return this.ops.ensureInvoiceForPendingOrder(orderId);
  }

  @Post("invoices/mark-paid")
  markPaid(@Body() dto: MarkPaidDto) {
    return this.ops.markInvoicePaid(dto);
  }
}
