import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Role } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService
  ) {}

  async seedOwner(email: string, password: string) {
    const hash = await bcrypt.hash(password, 10);
    return this.prisma.user.upsert({
      where: { email },
      update: { passwordHash: hash, role: Role.OWNER },
      create: { email, passwordHash: hash, role: Role.OWNER }
    });
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException("Invalid credentials.");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("Invalid credentials.");
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role
    });
    return { accessToken: token, role: user.role };
  }
}
