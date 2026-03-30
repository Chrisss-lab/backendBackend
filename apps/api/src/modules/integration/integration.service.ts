import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isHubSheetOnly } from "../../hub-mode";
import { PrismaService } from "../prisma/prisma.service";

interface WebhookEvent {
  sourceSystem: "consumer" | "worker";
  eventType: string;
  externalId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/** In-memory dedup when HUB_SHEET_ONLY (ephemeral across restarts). */
const sheetOnlySyncMemory = new Map<string, { id: string; lastSyncedAt: Date; payload: Record<string, unknown> }>();

@Injectable()
export class IntegrationService {
  constructor(private readonly prisma: PrismaService) {}

  async ingestEvent(input: WebhookEvent) {
    if (isHubSheetOnly()) {
      const key = `${input.sourceSystem}:${input.externalId}:${input.eventType}`;
      const existing = sheetOnlySyncMemory.get(key);
      if (existing) return { id: existing.id, ...input, lastSyncedAt: existing.lastSyncedAt } as any;
      const id = `mem_${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      sheetOnlySyncMemory.set(key, { id, lastSyncedAt: new Date(), payload: input.payload });
      return { id, ...input, lastSyncedAt: new Date() } as any;
    }
    const existing = await this.prisma.syncEvent.findUnique({
      where: { sourceSystem_externalId_eventType: { sourceSystem: input.sourceSystem, externalId: input.externalId, eventType: input.eventType } }
    });
    if (existing) return existing;

    return this.prisma.syncEvent.create({
      data: {
        sourceSystem: input.sourceSystem,
        eventType: input.eventType,
        externalId: input.externalId,
        payload: input.payload as Prisma.InputJsonValue,
        occurredAt: new Date(input.occurredAt),
        lastSyncedAt: new Date()
      }
    });
  }

  async reconcile() {
    if (isHubSheetOnly()) {
      return [...sheetOnlySyncMemory.values()].slice(-50);
    }
    return this.prisma.syncEvent.findMany({
      orderBy: { lastSyncedAt: "desc" },
      take: 50
    });
  }
}
