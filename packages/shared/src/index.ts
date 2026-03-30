export type AppRole = "OWNER" | "MANAGER";

export interface ExternalRef {
  sourceSystem: "consumer" | "worker";
  externalId: string;
}

export interface SyncEnvelope<T> {
  sourceSystem: ExternalRef["sourceSystem"];
  eventType: string;
  occurredAt: string;
  payload: T;
}
