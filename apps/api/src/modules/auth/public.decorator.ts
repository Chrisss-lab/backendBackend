import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/** Skips JWT when auth is enforced (login, webhooks with their own checks, etc.). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
