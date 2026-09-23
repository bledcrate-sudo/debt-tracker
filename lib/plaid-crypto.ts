import crypto from "crypto";

// Plaid access tokens are bearer credentials to a real bank account, so they
// never touch the database in plaintext. AES-256-GCM with a random IV per
// value; ciphertext is stored as "<iv>:<authTag>:<data>", all hex.
const ALGO = "aes-256-gcm";

function key(): Buffer {
  // Forgive quotes/whitespace pasted into a dashboard env var field.
  const raw = (process.env.PLAID_TOKEN_ENCRYPTION_KEY ?? "").trim().replace(/^["']|["']$/g, "").trim();
  if (!raw) throw new Error("PLAID_TOKEN_ENCRYPTION_KEY is not set");
  // Accept a 32-byte value as hex (64 chars) or base64.
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32)
    throw new Error("PLAID_TOKEN_ENCRYPTION_KEY must be 64 hex characters (or 32 bytes of base64)");
  return buf;
}

// Checked before anything irreversible — claiming a single-use SimpleFIN
// token or exchanging a Plaid public token — so a missing or malformed key
// fails up front instead of after the credential has been spent.
export function encryptionKeyError(): string | null {
  try {
    key();
    return null;
  } catch (e: any) {
    return `Server setup incomplete: ${e.message}. Add it in your deployment's environment variables and redeploy.`;
  }
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
