import crypto from "crypto";

// Plaid access tokens are bearer credentials to a real bank account, so they
// never touch the database in plaintext. AES-256-GCM with a random IV per
// value; ciphertext is stored as "<iv>:<authTag>:<data>", all hex.
const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("PLAID_TOKEN_ENCRYPTION_KEY is not set");
  // Accept a 32-byte value as hex (64 chars) or base64.
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32)
    throw new Error("PLAID_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (hex or base64)");
  return buf;
}

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptToken(stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed encrypted token");
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}
