import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Cloudflare R2 via S3-compatible API.
 * Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET to enable R2.
 * Set STORAGE_PUBLIC_BASE_URL to the public origin for the bucket (custom domain or r2.dev URL), no trailing slash.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;
  private bucket = "";
  private publicBase = "";

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const accountId = this.config.get<string>("R2_ACCOUNT_ID")?.trim();
    const accessKey = this.config.get<string>("R2_ACCESS_KEY_ID")?.trim();
    const secretKey = this.config.get<string>("R2_SECRET_ACCESS_KEY")?.trim();
    const bucket = this.config.get<string>("R2_BUCKET")?.trim();
    this.publicBase = (this.config.get<string>("STORAGE_PUBLIC_BASE_URL") || this.config.get<string>("R2_PUBLIC_BASE_URL") || "")
      .trim()
      .replace(/\/$/, "");

    const strictNoLocal =
      ["1", "true", "yes", "on"].indexOf(String(this.config.get<string>("STRICT_NO_LOCAL_STORAGE") || "").trim().toLowerCase()) >= 0;

    if (accountId && accessKey && secretKey && bucket) {
      this.bucket = bucket;
      this.client = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey }
      });
      this.logger.log(`R2 object storage enabled (bucket=${bucket})`);
      if (!this.publicBase) {
        this.logger.warn("STORAGE_PUBLIC_BASE_URL is not set — stored files need a public URL for the web app");
      }
    } else {
      if (strictNoLocal) {
        throw new Error(
          "STRICT_NO_LOCAL_STORAGE is enabled but object storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and STORAGE_PUBLIC_BASE_URL."
        );
      }
      this.logger.log("Object storage is not configured. Local disk fallback remains enabled.");
    }
  }

  usesObjectStorage(): boolean {
    return this.client !== null;
  }

  invoicePrimaryKey(invoiceId: string): string {
    return `invoices/${invoiceId}.pdf`;
  }

  /** e.g. `JR-2025-0001.pdf` */
  invoiceArchiveObjectKey(archivePdfFileName: string): string {
    return `invoices/archive/${archivePdfFileName.replace(/^\/+/, "")}`;
  }

  expenseKey(filename: string): string {
    return `expenses/${filename}`;
  }

  /** Full public URL for R2; local fallback path is only used when strict mode is disabled. */
  publicUrlForKey(key: string): string {
    const k = key.replace(/^\/+/, "");
    if (!this.publicBase) {
      if (k.startsWith("invoices/")) {
        const base = k.replace(/^invoices\//, "");
        return `/uploads/invoices/${base}`;
      }
      if (k.startsWith("expenses/")) {
        return `/uploads/${k}`;
      }
      return `/${k}`;
    }
    return `${this.publicBase}/${k}`;
  }

  async putPdf(key: string, body: Buffer): Promise<void> {
    await this.putObject(key, body, "application/pdf");
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    if (!this.client) {
      throw new Error("Object storage is not configured");
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key.replace(/^\/+/, ""),
        Body: body,
        ContentType: contentType
      })
    );
  }

}
