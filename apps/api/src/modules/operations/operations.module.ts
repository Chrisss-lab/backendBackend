import { Module } from "@nestjs/common";
import { OperationsController } from "./operations.controller";
import { OperationsService } from "./operations.service";

@Module({
  imports: [],
  controllers: [OperationsController],
  providers: [OperationsService],
  exports: [OperationsService]
})
export class OperationsModule {}
