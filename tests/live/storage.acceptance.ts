import { describe, expect, it } from "vitest";
import { requireLiveEnv } from "./live-config";

/**
 * Live object-storage acceptance: put → download → compare → signed URL →
 * delete against the real bucket, under a disposable prefix. Fails loudly
 * without credentials and cleans up after itself.
 */
describe("Live: object storage round trip", () => {
  it("uploads, reads back, signs and deletes a real object", async () => {
    requireLiveEnv(["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"], "object storage");
    const { getStorageProvider } = await import("@/lib/providers/storage");
    const storage = getStorageProvider();
    if (!storage) throw new Error("Live acceptance unavailable: STORAGE_PROVIDER must be s3 for live storage acceptance");
    const key = `live-acceptance/${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const payload = Buffer.from(`منشی هوشمند live acceptance ${new Date().toISOString()}`, "utf8");
    try {
      const uploaded = await storage.upload({ key, data: payload, contentType: "text/plain" });
      expect(uploaded.key).toBe(key);
      expect(uploaded.bytes).toBe(payload.length);
      const downloaded = await storage.download(key);
      expect(Buffer.compare(downloaded, payload)).toBe(0);
      const signed = await storage.getSignedUrl(key, 60);
      expect(signed).toMatch(/^https?:\/\//);
      if (storage.list) {
        const listed = await storage.list("live-acceptance/");
        expect(listed.some((entry) => entry.key === key)).toBe(true);
      }
      console.log(`[live:storage] provider=${storage.name} bytes=${payload.length}`);
    } finally {
      await storage.delete(key).catch(() => undefined);
    }
  }, 120_000);
});
