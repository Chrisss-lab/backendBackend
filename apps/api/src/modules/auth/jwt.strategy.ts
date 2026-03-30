import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { isHubSheetOnly } from "../../hub-mode";
import { PrismaService } from "../prisma/prisma.service";

export type JwtPayload = { sub: string; email: string; role: string };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET ?? "dev-secret"
    });
  }

  async validate(payload: JwtPayload) {
    if (isHubSheetOnly()) {
      const sub = String(payload?.sub ?? "").trim();
      const email = String(payload?.email ?? "").trim();
      const role = String(payload?.role ?? "OWNER").trim();
      if (!sub || !email) throw new UnauthorizedException();
      return { userId: sub, email, role };
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException();
    return { userId: user.id, email: user.email, role: user.role };
  }
}
