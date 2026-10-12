import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";

export function digestIdentity(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function encodeBase32(bytes: Buffer): string {
  let bits = 0, value = 0, result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
export function decodeBase32(secret: string): Buffer {
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}
/** RFC 6238: 30-second time step, HMAC-SHA1, dynamic truncation. */
export function totp(secret: string, seconds = Date.now() / 1000, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const mac = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}
export function matchingTotpStep(secret: string, code: string, lastStep: number, seconds = Date.now() / 1000): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(seconds / 30);
  for (const step of [current, current - 1, current + 1]) {
    if (step > lastStep && timingSafeEqual(Buffer.from(totp(secret, step * 30)), Buffer.from(code))) return step;
  }
  return null;
}
function key(): Buffer {
  const value = process.env.IDENTITY_ENCRYPTION_KEY;
  if (!value || !/^[a-f\d]{64}$/i.test(value)) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "IDENTITY_ENCRYPTION_KEY must contain 32 random bytes encoded as hex");
  return Buffer.from(value, "hex");
}
export function encryptMfa(secret: string, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(userId));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}
export function decryptMfa(value: string, userId: string): string {
  const [iv, tag, data] = value.split(".").map((s) => Buffer.from(s, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(userId)); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
export function newMfaSecret(): string { return encodeBase32(randomBytes(20)); }
export function newRecoveryCodes(): string[] { return Array.from({ length: 10 }, () => randomBytes(12).toString("hex")); }
