import { Body, Controller, Post } from "@nestjs/common";
import { IsEmail, IsString, MinLength } from "class-validator";
import { AuthService } from "./auth.service";

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("seed-owner")
  seedOwner(@Body() dto: LoginDto) {
    return this.auth.seedOwner(dto.email, dto.password);
  }

  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }
}
