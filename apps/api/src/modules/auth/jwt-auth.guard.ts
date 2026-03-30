import { ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { Request } from "express";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { jwtAuthEnforced } from "./auth-security.util";

/** Same-origin hub: Nest serves Next static export; these GETs must not require JWT */
function isPublicStaticHubRequest(req: Request): boolean {
  if (req.method !== "GET") return false;
  const p = String(req.path || "");
  if (p === "/" || p.startsWith("/_next/")) return true;
  if (/\.[a-z0-9]{1,8}$/i.test(p)) return true;
  return false;
}

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    if (!jwtAuthEnforced()) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (isPublicStaticHubRequest(req)) return true;
    return super.canActivate(context) as boolean | Promise<boolean>;
  }
}
