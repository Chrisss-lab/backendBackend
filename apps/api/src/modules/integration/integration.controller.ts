import { Body, Controller, Get, Post } from "@nestjs/common";
import { IsIn, IsISO8601, IsObject, IsString } from "class-validator";
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

@Controller("integration")
export class IntegrationController {
  constructor(private readonly integration: IntegrationService) {}

  @Post("webhook")
  ingest(@Body() dto: WebhookDto) {
    return this.integration.ingestEvent(dto);
  }

  @Get("reconcile")
  reconcile() {
    return this.integration.reconcile();
  }
}
