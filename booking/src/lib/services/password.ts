import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: object,
) => Promise<Buffer>;
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * N * R });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Always do comparable work so response time does not reveal whether the account exists.
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    await scrypt(password, Buffer.alloc(16), KEYLEN, { N, r: R, p: P, maxmem: 256 * N * R });
    return false;
  }
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * Number(n) * Number(r),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const COMMON = new Set(["password1234", "123456789012", "qwertyuiop12", "changeme1234", "welcome12345"]);

/** Returns an error message, or null when acceptable. NIST-style: length over composition rules. */
export function checkPasswordPolicy(password: string, email?: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 128) return "Password must be at most 128 characters.";
  if (COMMON.has(password.toLowerCase())) return "That password is too common.";
  if (email && password.toLowerCase().includes(email.split("@")[0]?.toLowerCase() ?? "\0"))
    return "Password must not contain your email name.";
  if (/^(.)\1+$/.test(password)) return "Password is too repetitive.";
  return null;
}

export const newToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
