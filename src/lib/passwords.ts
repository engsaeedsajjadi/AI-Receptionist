import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { compare } from "bcryptjs";
const PREFIX = "$scrypt$n=32768,r=8,p=3$";
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}
/** Memory-hard hashing with full UTF-8 input; no bcrypt 72-byte truncation for new passwords. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${PREFIX}${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (/^\$2[aby]\$/.test(encoded)) return compare(password, encoded); // Migration compatibility.
  if (!encoded.startsWith(PREFIX)) return false;
  const parts = encoded.slice(PREFIX.length).split("$");
  if (parts.length !== 2 || !/^[a-f\d]{32}$/.test(parts[0]) || !/^[a-f\d]{64}$/.test(parts[1])) return false;
  return timingSafeEqual(await derive(password, Buffer.from(parts[0], "hex")), Buffer.from(parts[1], "hex"));
}
