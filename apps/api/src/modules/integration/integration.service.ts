import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

interface WebhookEvent {
  sourceSystem: "consumer" | "worker";
  eventType: string;
  externalId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

@Injectable()
export class IntegrationService {
  constructor(private readonly prisma: PrismaService) {}

  async ingestEvent(input: WebhookEvent) {
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
    return this.prisma.syncEvent.findMany({
      orderBy: { lastSyncedAt: "desc" },
      take: 50
    });
  }
}
