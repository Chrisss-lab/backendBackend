import { Body, Controller, ForbiddenException, Get, Headers, Post, UnauthorizedException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Type } from "class-transformer";
import { IsArray, IsIn, IsISO8601, IsNumber, IsObject, IsOptional, IsString, ValidateNested } from "class-validator";
import { timingSafeEqualStr } from "../auth/auth-security.util";
import { Public } from "../auth/public.decorator";
import { OperationsService } from "../operations/operations.service";
import { IntegrationService } from "./integration.service";

class WebhookDto {
  @IsIn(["consumer", "worker"])
  sourceSystem!: "consumer" | "worker";

  @IsString()
  eventType!: string;

  @IsString()
  externalId!: string;

  @IsObject()
  payload!: Record<string, unknown>;

  @IsISO8601()
  occurredAt!: string;
}

/** Same shape as Google Apps Script `submitOrder` (consumer website). */
class FinalOrderItemDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  productName?: string;

  @IsNumber()
  quantity!: number;

  @IsOptional()
  @IsString()
  quantityUnit?: string;

  @IsOptional()
  @IsNumber()
  unitPrice?: number;
}

class FinalSubmitOrderDto {
  @IsString()
  customerName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FinalOrderItemDto)
  items!: FinalOrderItemDto[];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  promoCode?: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  createdAt?: string;
}

@Controller("integration")
export class IntegrationController {
  constructor(
    private readonly integration: IntegrationService,
    private readonly ops: OperationsService
  ) {}

  @Public()
  @SkipThrottle()
  @Post("webhook")
  ingest(@Headers("x-webhook-secret") webhookSecret: string | undefined, @Body() dto: WebhookDto) {
    const expected = process.env.INTEGRATION_WEBHOOK_SECRET?.trim();
    const prod = process.env.NODE_ENV === "production";
    if (prod) {
      if (!expected) throw new ForbiddenException("INTEGRATION_WEBHOOK_SECRET is not set.");
      if (!webhookSecret || !timingSafeEqualStr(webhookSecret.trim(), expected)) {
        throw new UnauthorizedException();
      }
    } else if (expected && (!webhookSecret || !timingSafeEqualStr(webhookSecret.trim(), expected))) {
      throw new UnauthorizedException();
    }
    return this.integration.ingestEvent(dto);
  }

  @Get("reconcile")
  reconcile() {
    return this.integration.reconcile();
  }

  /**
   * Fast path for the Final consumer site: server relays to the configured Google Apps Script `submitOrder`
   * in one hop (TLS + JSON), so the browser does not wait on script.google.com redirects.
   */
  @Public()
  @SkipThrottle()
  @Post("final/submit-order")
  finalSubmitOrder(@Headers("x-final-order-secret") secret: string | undefined, @Body() dto: FinalSubmitOrderDto) {
    const expected = process.env.FINAL_ORDER_SUBMIT_SECRET?.trim();
    if (!expected) {
      throw new ForbiddenException("FINAL_ORDER_SUBMIT_SECRET is not configured on the API.");
    }
    if (!secret || !timingSafeEqualStr(secret.trim(), expected)) {
      throw new UnauthorizedException("Invalid or missing X-Final-Order-Secret.");
    }
    return this.ops.finalSiteExpressSubmitOrder(dto);
  }
}
