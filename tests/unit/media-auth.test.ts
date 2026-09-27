import { describe, expect, it } from "vitest";
import { createMediaSessionToken, verifyMediaSessionToken } from "@/lib/voice/media-auth";

describe("media session auth", () => {
  it("binds a short-lived token to one business and call", () => {
    const token = createMediaSessionToken("secret", {
      businessId: "biz-1",
      callId: "call-1",
      externalCallId: "ext-1",
      ttlSeconds: 60,
    });
    expect(verifyMediaSessionToken(token, "secret", {
      businessId: "biz-1",
      callId: "call-1",
      externalCallId: "ext-1",
    })).toMatchObject({ businessId: "biz-1", callId: "call-1", externalCallId: "ext-1" });
    expect(verifyMediaSessionToken(token, "secret", { businessId: "biz-2", callId: "call-1" })).toBeNull();
  });

  it("rejects tampering", () => {
    const token = createMediaSessionToken("secret", { businessId: "biz-1", callId: "call-1" });
    const tampered = `${token}x`;
    expect(verifyMediaSessionToken(tampered, "secret", { businessId: "biz-1", callId: "call-1" })).toBeNull();
  });
});
