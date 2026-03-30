import { Module } from "@nestjs/common";
import { OperationsModule } from "../operations/operations.module";
import { PrismaModule } from "../prisma/prisma.module";
import { IntegrationController } from "./integration.controller";
import { IntegrationService } from "./integration.service";

@Module({
  imports: [PrismaModule, OperationsModule],
  controllers: [IntegrationController],
  providers: [IntegrationService],
  exports: [IntegrationService]
})
export class IntegrationModule {}
