import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? "dev-secret",
      signOptions: { expiresIn: "8h" }
    })
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService]
})
export class AuthModule {}
