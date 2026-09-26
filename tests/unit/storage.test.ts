import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalStorageProvider,
  S3StorageProvider,
  contentTypeForFilename,
  getStorageProvider,
  tenantKey,
  verifyLocalSignedUrl,
} from "@/lib/providers/storage";

describe("tenantKey", () => {
  it("builds tenant-scoped keys", () => {
    expect(tenantKey("biz-1", "recordings", "call-9.wav")).toBe("business/biz-1/recordings/call-9.wav");
  });

  it("neutralizes traversal segments and unsafe characters", () => {
    const key = tenantKey("biz-1", "..", "..\\..\\etc", "a b/c?.wav");
    expect(key.startsWith("business/biz-1/")).toBe(true);
    expect(key).not.toContain("..");
    expect(key).not.toContain(" ");
    expect(key).not.toContain("?");
    expect(key).not.toContain("\\");
  });

  it("drops empty and dot segments", () => {
    expect(tenantKey("biz-1", "", ".", "calls", "", "x.mp3")).toBe("business/biz-1/calls/x.mp3");
  });
});

describe("LocalStorageProvider", () => {
  async function tmpProvider() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-test-"));
    return { dir, provider: new LocalStorageProvider(dir) };
  }

  it("round-trips upload → download → delete", async () => {
    const { provider } = await tmpProvider();
    const key = tenantKey("biz-1", "tts", "reply.mp3");
    const data = Buffer.from("fake-audio-bytes");
    const up = await provider.upload({ key, data, contentType: "audio/mpeg" });
    expect(up).toEqual({ key, bytes: data.length });
    expect(await provider.download(key)).toEqual(data);
    await provider.delete(key);
    await expect(provider.download(key)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects traversal; leading slashes normalize to a contained relative key", async () => {
    const { dir, provider } = await tmpProvider();
    await expect(provider.upload({ key: "../escape.txt", data: Buffer.of(1), contentType: "text/plain" })).rejects
      .toMatchObject({ code: "INVALID_PAYLOAD" });
    // Downloads map invalid keys to NOT_FOUND (no invalid-vs-missing oracle).
    await expect(provider.download("business/x/../../y")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // "/etc/passwd" is NOT an escape: leading slashes are stripped and the
    // key resolves inside the storage root (containment enforced by resolve()).
    const up = await provider.upload({ key: "/etc/passwd", data: Buffer.of(1), contentType: "text/plain" });
    expect(up.key).toBe("etc/passwd");
    expect(await provider.download("etc/passwd")).toEqual(Buffer.of(1));
    await expect(fs.stat(path.join(dir, "etc", "passwd"))).resolves.toBeTruthy();
  });

  it("404s honestly on missing keys", async () => {
    const { provider } = await tmpProvider();
    await expect(provider.download(tenantKey("biz-1", "nope.wav"))).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("signs capability URLs that verify, and rejects tampering/expiry", async () => {
    const { provider } = await tmpProvider();
    const key = tenantKey("biz-1", "tts", "reply.mp3");
    const url = new URL(await provider.getSignedUrl(key, 3600));
    const expires = url.searchParams.get("expires")!;
    const sig = url.searchParams.get("sig")!;
    expect(url.pathname).toContain("/api/v1/files/business/biz-1/tts/reply.mp3");
    expect(verifyLocalSignedUrl(key, expires, sig)).toBe(true);
    // Tampered signature / key / expiry all fail closed.
    expect(verifyLocalSignedUrl(key, expires, `${sig.slice(0, -1)}0`)).toBe(false);
    expect(verifyLocalSignedUrl(tenantKey("biz-1", "tts", "other.mp3"), expires, sig)).toBe(false);
    expect(verifyLocalSignedUrl(key, "not-a-number", sig)).toBe(false);
    const expired = new URL(await provider.getSignedUrl(key, -10));
    expect(
      verifyLocalSignedUrl(key, expired.searchParams.get("expires")!, expired.searchParams.get("sig")!),
    ).toBe(false);
  });
});

describe("S3StorageProvider", () => {
  it("fails fast without configuration (never a silent no-op)", async () => {
    expect(() => new S3StorageProvider()).toThrowError(/not configured/i);
    try {
      new S3StorageProvider();
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 503, code: "PROVIDER_NOT_CONFIGURED" });
    }
  });

  it("constructs lazily with explicit overrides (no network on construct)", () => {
    const provider = new S3StorageProvider({
      endpoint: "https://s3.example.invalid",
      region: "us-east-1",
      bucket: "test",
      accessKeyId: "id",
      secretAccessKey: "secret",
    });
    expect(provider.name).toBe("s3");
  });
});

describe("getStorageProvider / contentTypeForFilename", () => {
  it("resolves the local provider in test env", () => {
    expect(getStorageProvider().name).toBe("local");
  });

  it("maps known extensions, defaults unknown to octet-stream", () => {
    expect(contentTypeForFilename("doc.PDF")).toBe("application/pdf");
    expect(contentTypeForFilename("file.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(contentTypeForFilename("n.md")).toBe("text/markdown");
    expect(contentTypeForFilename("n.txt")).toBe("text/plain");
    expect(contentTypeForFilename("a.mp3")).toBe("audio/mpeg");
    expect(contentTypeForFilename("evil.exe")).toBe("application/octet-stream");
  });
});
