import { createHash, randomInt } from "crypto";
import { prisma } from "./prisma";

// iPhone widget pairing. The widget generates its own random key (64 hex
// chars) and sends it as a bearer token; only its SHA-256 is stored. Until
// linked, the device carries a 6-digit pairing code the user types into the
// app (signed in), which ties the device to their account.
export const PAIR_CODE_TTL_MS = 30 * 60_000;

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function bearerKey(req: Request): string | null {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1].toLowerCase() : null;
}

// Normalizes what the user typed ("482 913", "482-913") to 6 digits.
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  return digits.length === 6 ? digits : null;
}

async function freshCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const taken = await prisma.widgetDevice.findFirst({
      where: { pairCode: code, pairCodeExpiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!taken) {
      // A stale holder of the same code would block the unique index.
      await prisma.widgetDevice.updateMany({ where: { pairCode: code }, data: { pairCode: null, pairCodeExpiresAt: null } });
      return code;
    }
  }
  throw new Error("Couldn't make a pairing code");
}

// The device for this key, created on first contact, with a valid pairing
// code if it isn't linked yet.
export async function widgetDevice(key: string) {
  const keyHash = hashKey(key);
  const now = new Date();
  let device = await prisma.widgetDevice.findUnique({ where: { keyHash } });
  if (!device) {
    // Keep abandoned, never-linked devices from piling up.
    await prisma.widgetDevice.deleteMany({ where: { userId: null, createdAt: { lt: new Date(now.getTime() - 86400_000) } } });
    device = await prisma.widgetDevice.create({
      data: { keyHash, pairCode: await freshCode(), pairCodeExpiresAt: new Date(now.getTime() + PAIR_CODE_TTL_MS) },
    });
  } else if (!device.userId && (!device.pairCode || !device.pairCodeExpiresAt || device.pairCodeExpiresAt < now)) {
    device = await prisma.widgetDevice.update({
      where: { id: device.id },
      data: { pairCode: await freshCode(), pairCodeExpiresAt: new Date(now.getTime() + PAIR_CODE_TTL_MS) },
    });
  }
  return device;
}
