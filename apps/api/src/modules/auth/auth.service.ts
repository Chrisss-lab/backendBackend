import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Role } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { isHubSheetOnly } from "../../hub-mode";
import { PrismaService } from "../prisma/prisma.service";
import { timingSafeEqualStr } from "./auth-security.util";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService
  ) {}

  assertSeedOwnerAllowed(setupSecretHeader: string | undefined) {
    const isProd = process.env.NODE_ENV === "production";
    const expected = process.env.OWNER_SETUP_SECRET?.trim();
    if (!isProd) return;
    if (!expected) {
      throw new ForbiddenException("OWNER_SETUP_SECRET is not set; owner bootstrap is disabled in production.");
    }
    if (!setupSecretHeader || !timingSafeEqualStr(setupSecretHeader.trim(), expected)) {
      throw new ForbiddenException("Invalid or missing X-Setup-Secret.");
    }
  }

  async seedOwner(email: string, password: string) {
    if (isHubSheetOnly()) {
      throw new ForbiddenException("Owner seed is disabled in HUB_SHEET_ONLY mode. Use Google Sheet login.");
    }
    const hash = await bcrypt.hash(password, 10);
    return this.prisma.user.upsert({
      where: { email },
      update: { passwordHash: hash, role: Role.OWNER },
      create: { email, passwordHash: hash, role: Role.OWNER }
    });
  }

  async login(email: string, password: string) {
    if (isHubSheetOnly()) {
      throw new UnauthorizedException("Use Sign in with Google Sheet (not email/password).");
    }
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

  /**
   * After the browser obtains sessionToken from Apps Script (action=login), exchange it for an API JWT.
   * Server verifies via ?action=sessionPing, then signs as the hub user (see SHEET_HUB_JWT_EMAIL).
   */
  async exchangeSheetWebSession(sessionToken: string) {
    const raw = String(sessionToken || "").trim();
    if (!raw) throw new UnauthorizedException("sessionToken is required.");

    const base = (process.env.GOOGLE_SHEET_APPS_SCRIPT_URL ?? process.env.GOOGLE_SHEET_LOGIN_APPS_SCRIPT_URL ?? "").trim();
    if (!base) {
      throw new UnauthorizedException("GOOGLE_SHEET_APPS_SCRIPT_URL is not configured on the API.");
    }
    const pingUrl = `${base.replace(/\/$/, "")}?action=sessionPing&sessionToken=${encodeURIComponent(raw)}`;
    let data: { ok?: boolean; valid?: boolean };
    try {
      const res = await fetch(pingUrl, { method: "GET", redirect: "follow" });
      data = (await res.json()) as typeof data;
    } catch {
      throw new UnauthorizedException("Could not verify session with Google Apps Script.");
    }
    if (!data?.ok || !data?.valid) {
      throw new UnauthorizedException("Invalid or expired Apps Script session.");
    }

    if (isHubSheetOnly()) {
      const sub = String(process.env.SHEET_HUB_JWT_SUB ?? "").trim() || "hub-sheet-owner";
      const emailJwt = String(process.env.SHEET_HUB_JWT_EMAIL ?? "").trim() || "owner@hub.local";
      const r = String(process.env.SHEET_HUB_JWT_ROLE ?? "").trim().toUpperCase();
      const roleJwt = r === "MANAGER" ? Role.MANAGER : Role.OWNER;
      const accessToken = await this.jwt.signAsync({
        sub,
        email: emailJwt,
        role: roleJwt
      });
      return { accessToken, role: roleJwt };
    }

    const email = process.env.SHEET_HUB_JWT_EMAIL?.trim();
    const user = email
      ? await this.prisma.user.findUnique({ where: { email } })
      : await this.prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
    if (!user) {
      throw new UnauthorizedException(
        email
          ? `No user with email ${email}. Create that user or unset SHEET_HUB_JWT_EMAIL.`
          : "No users in database. Run POST /auth/seed-owner first."
      );
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role
    });
    return { accessToken, role: user.role };
  }

  /**
   * Server-side WebLogin: POST to Apps Script action=login (avoids browser CORS to script.google.com), then issue JWT.
   */
  async loginViaSheetWeb(username: string, password: string) {
    const u = String(username || "").trim();
    const p = String(password ?? "");
    const base = (process.env.GOOGLE_SHEET_APPS_SCRIPT_URL ?? process.env.GOOGLE_SHEET_LOGIN_APPS_SCRIPT_URL ?? "").trim();
    if (!base) {
      throw new BadRequestException("GOOGLE_SHEET_APPS_SCRIPT_URL is not configured on the API.");
    }
    const url = base.replace(/\/$/, "");
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ action: "login", username: u, password: p })
      });
    } catch {
      throw new BadRequestException("Could not reach Google Apps Script from the API. Check the URL and deployment.");
    }
    const text = await res.text();
    let parsed: { ok?: boolean; sessionToken?: string; error?: string };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new BadRequestException(
        `Apps Script returned non-JSON (HTTP ${res.status}). Check GOOGLE_SHEET_APPS_SCRIPT_URL and Web App deploy.`
      );
    }
    if (!parsed.ok || !parsed.sessionToken) {
      throw new UnauthorizedException(parsed.error || "Invalid username or password.");
    }
    return this.exchangeSheetWebSession(parsed.sessionToken);
  }
}
