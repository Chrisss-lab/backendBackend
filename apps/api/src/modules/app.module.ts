import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { existsSync } from "fs";
import { resolve } from "path";
import { AuthModule } from "./auth/auth.module";
import { IntegrationModule } from "./integration/integration.module";
import { OperationsModule } from "./operations/operations.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ReportsModule } from "./reports/reports.module";
import { GoogleModule } from "./google/google.module";
import { StorageModule } from "../storage/storage.module";

const envFileCandidates = [
  resolve(process.cwd(), "apps", "api", ".env"),
  resolve(process.cwd(), ".env"),
  resolve(__dirname, "..", "..", ".env")
].filter((p) => existsSync(p));

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ...(envFileCandidates.length ? { envFilePath: envFileCandidates } : {})
    }),
    PrismaModule,
    StorageModule,
    AuthModule,
    IntegrationModule,
    OperationsModule,
    ReportsModule,
    GoogleModule
  ]
})
export class AppModule {}
