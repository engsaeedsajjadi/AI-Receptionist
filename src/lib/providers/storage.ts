import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AppError } from "@/lib/errors";
import { env, getEnv } from "@/lib/env";
import { logError } from "@/lib/logger";

export type UploadInput = {
  /** Tenant-scoped object key, e.g. "business/<id>/recordings/<file>". */
  key: string;
  data: Buffer;
  contentType: string;
};

export type UploadResult = { key: string; bytes: number };

export interface StorageProvider {
  readonly name: string;
  upload(input: UploadInput): Promise<UploadResult>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

function assertSafeKey(key: string): string {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new AppError(400, "INVALID_PAYLOAD", "Invalid storage key");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(normalized)) {
    throw new AppError(400, "INVALID_PAYLOAD", "Invalid storage key characters");
  }
  return normalized;
}

/** Build a tenant-scoped key. Never trust caller-provided business prefixes. */
export function tenantKey(businessId: string, ...parts: string[]): string {
  const safe = parts
    .map((p) => p.replace(/\\/g, "/"))
    .join("/")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, "_"))
    .join("/");
  return assertSafeKey(`business/${businessId}/${safe}`);
}

// ---------------------------------------------------------------------------
// Local (development) provider
// ---------------------------------------------------------------------------

export class LocalStorageProvider implements StorageProvider {
  readonly name = "local";
  private root: string;

  constructor(rootDir?: string) {
    this.root = path.resolve(rootDir ?? getEnv().LOCAL_STORAGE_DIR);
  }

  private resolve(key: string): string {
    const safe = assertSafeKey(key);
    const full = path.resolve(this.root, safe);
    if (!full.startsWith(`${this.root}${path.sep}`) && full !== this.root) {
      throw new AppError(400, "INVALID_PAYLOAD", "Storage key escapes root directory");
    }
    return full;
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    const full = this.resolve(input.key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, input.data);
    await fs.writeFile(`${full}.meta.json`, JSON.stringify({ contentType: input.contentType }));
    return { key: assertSafeKey(input.key), bytes: input.data.length };
  }

  async download(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      throw new AppError(404, "NOT_FOUND", "Object not found");
    }
  }

  async delete(key: string): Promise<void> {
    const full = this.resolve(key);
    await fs.rm(full, { force: true });
    await fs.rm(`${full}.meta.json`, { force: true });
  }

  /** HMAC-signed capability URL served by /api/v1/files/[...key]. */
  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const safe = assertSafeKey(key);
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = createHmac("sha256", env.jwtSecret).update(`${safe}:${expires}`).digest("hex");
    const base = getEnv().APP_URL.replace(/\/$/, "");
    return `${base}/api/v1/files/${safe.split("/").map(encodeURIComponent).join("/")}?expires=${expires}&sig=${sig}`;
  }
}

export function verifyLocalSignedUrl(key: string, expires: string, sig: string): boolean {
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = createHmac("sha256", env.jwtSecret).update(`${key}:${expires}`).digest("hex");
  return expected.length === sig.length && createHmac("sha256", "compare").update(expected).digest("hex") ===
    createHmac("sha256", "compare").update(sig).digest("hex");
}

// ---------------------------------------------------------------------------
// S3 (production) provider
// ---------------------------------------------------------------------------

export class S3StorageProvider implements StorageProvider {
  readonly name = "s3";
  private client: S3Client;
  private bucket: string;

  constructor(overrides?: { endpoint?: string; region?: string; bucket?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle?: boolean }) {
    const e = getEnv();
    const endpoint = overrides?.endpoint ?? e.S3_ENDPOINT;
    const accessKeyId = overrides?.accessKeyId ?? e.S3_ACCESS_KEY_ID;
    const secretAccessKey = overrides?.secretAccessKey ?? e.S3_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "S3 storage is not configured");
    }
    this.bucket = overrides?.bucket ?? e.S3_BUCKET;
    this.client = new S3Client({
      endpoint,
      region: overrides?.region ?? e.S3_REGION,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: overrides?.forcePathStyle ?? e.S3_FORCE_PATH_STYLE,
    });
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    const key = assertSafeKey(input.key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: input.data,
          ContentType: input.contentType,
          ContentLength: input.data.length,
        }),
      );
      return { key, bytes: input.data.length };
    } catch (err) {
      logError("S3 upload failed", { provider: this.name, operation: "storage.upload", status: "error", error: err });
      throw new AppError(502, "STORAGE_ERROR", "Object upload failed");
    }
  }

  async download(key: string): Promise<Buffer> {
    const safe = assertSafeKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safe }));
      const body = res.Body as unknown as
        | { transformToByteArray: () => Promise<Uint8Array> }
        | AsyncIterable<Uint8Array>
        | undefined;
      if (!body) throw new AppError(404, "NOT_FOUND", "Object not found");
      if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
        const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
        return Buffer.from(bytes);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof AppError) throw err;
      const name = (err as { name?: string })?.name ?? "";
      if (name === "NoSuchKey" || name === "NotFound") throw new AppError(404, "NOT_FOUND", "Object not found");
      logError("S3 download failed", { provider: this.name, operation: "storage.download", status: "error", error: err });
      throw new AppError(502, "STORAGE_ERROR", "Object download failed");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: assertSafeKey(key) }));
    } catch (err) {
      logError("S3 delete failed", { provider: this.name, operation: "storage.delete", status: "error", error: err });
      throw new AppError(502, "STORAGE_ERROR", "Object delete failed");
    }
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: assertSafeKey(key) }),
        { expiresIn: expiresInSeconds },
      );
    } catch (err) {
      logError("S3 signed URL failed", { provider: this.name, operation: "storage.signed_url", status: "error", error: err });
      throw new AppError(502, "STORAGE_ERROR", "Signed URL generation failed");
    }
  }
}

export function getStorageProvider(): StorageProvider {
  switch (getEnv().STORAGE_PROVIDER) {
    case "s3":
      return new S3StorageProvider();
    case "local":
      return new LocalStorageProvider();
  }
}

/** Guess a safe content type for a small set of known extensions. */
export function contentTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".m4a")) return "audio/x-m4a";
  return "application/octet-stream";
}
