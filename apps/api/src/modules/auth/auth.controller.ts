import { Body, Controller, Headers, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { IsEmail, IsString, MinLength } from "class-validator";
import { AuthService } from "./auth.service";
import { Public } from "./public.decorator";

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

class SheetSessionDto {
  @IsString()
  @MinLength(12)
  sessionToken!: string;
}

class SheetWebLoginDto {
  @IsString()
  @MinLength(1)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("seed-owner")
  seedOwner(@Headers("x-setup-secret") setupSecret: string | undefined, @Body() dto: LoginDto) {
    this.auth.assertSeedOwnerAllowed(setupSecret);
    return this.auth.seedOwner(dto.email, dto.password);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Browser: after Apps Script POST action=login, send sessionToken here to get a normal API JWT. */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post("sheet-session")
  sheetSession(@Body() dto: SheetSessionDto) {
    return this.auth.exchangeSheetWebSession(dto.sessionToken);
  }

  /** Browser: username/password checked on WebLogin tab — API calls Apps Script (no CORS in the browser). */
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 25 } })
  @Post("sheet-web-login")
  sheetWebLogin(@Body() dto: SheetWebLoginDto) {
    return this.auth.loginViaSheetWeb(dto.username, dto.password);
  }
}
