/** App enums (no Prisma dependency for operational models). */

export enum OrderStatus {
  NEW = "NEW",
  CONFIRMED = "CONFIRMED",
  FULFILLED = "FULFILLED",
  CANCELLED = "CANCELLED"
}

export enum PromoKind {
  COUPON = "COUPON",
  COOP = "COOP"
}
