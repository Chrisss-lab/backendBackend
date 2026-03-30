import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OperationsModule } from "../operations/operations.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [PrismaModule, OperationsModule],
  controllers: [ReportsController],
  providers: [ReportsService]
})
export class ReportsModule {}
