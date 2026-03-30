import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ServeStaticModule } from "@nestjs/serve-static";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { existsSync } from "fs";
import { resolve } from "path";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { IntegrationModule } from "./integration/integration.module";
import { OperationsModule } from "./operations/operations.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ReportsModule } from "./reports/reports.module";
import { GoogleModule } from "./google/google.module";
import { StorageModule } from "../storage/storage.module";
import { resolveWebOutDir } from "../hub-static-path";

const envFileCandidates = [
  resolve(process.cwd(), "apps", "api", ".env"),
  resolve(process.cwd(), ".env"),
  resolve(__dirname, "..", "..", ".env")
].filter((p) => existsSync(p));

const webOutDir = resolveWebOutDir();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ...(envFileCandidates.length ? { envFilePath: envFileCandidates } : {})
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 400 }]
    }),
    PrismaModule,
    StorageModule,
    AuthModule,
    IntegrationModule,
    OperationsModule,
    ReportsModule,
    GoogleModule,
    ...(webOutDir
      ? [
          ServeStaticModule.forRoot({
            rootPath: webOutDir,
            serveRoot: "/",
            exclude: ["/auth*", "/operations*", "/reports*", "/integration*", "/integrations*", "/uploads*"]
          })
        ]
      : [])
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard }
  ]
})
export class AppModule {}
