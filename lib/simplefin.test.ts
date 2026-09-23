import { describe, it, expect, afterEach } from "vitest";
import { encryptionKeyError } from "./plaid-crypto";
import {
  createConnection,
  decodeSetupToken,
  claimAccessUrl,
  fetchAccountSet,
  guessKind,
  owedFrom,
  transactionDate,
  sanitizeMessage,
  SimplefinError,
} from "./simplefin";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const stubFetch = (status: number, body: string, seen?: { url?: string; init?: RequestInit }) =>
  (async (url: any, init?: RequestInit) => {
    if (seen) Object.assign(seen, { url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;

describe("decodeSetupToken", () => {
  it("decodes the base64 claim URL", () => {
    const url = "https://bridge.example.org/simplefin/claim/ABC123";
    expect(decodeSetupToken(b64(url))).toBe(url);
  });
  it("tolerates surrounding whitespace from copy/paste", () => {
    expect(decodeSetupToken(`  ${b64("https://x.org/claim/1")}\n`)).toBe("https://x.org/claim/1");
  });
  it("rejects non-https claim URLs", () => {
    expect(() => decodeSetupToken(b64("http://x.org/claim/1"))).toThrow(SimplefinError);
  });
  it("rejects garbage", () => {
    expect(() => decodeSetupToken("not a token")).toThrow(SimplefinError);
  });
});

describe("claimAccessUrl", () => {
  const token = b64("https://bridge.example.org/simplefin/claim/ABC");
  it("POSTs to the claim URL and returns the access URL", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const url = await claimAccessUrl(token, stubFetch(200, "https://u:p@bridge.example.org/simplefin\n", seen));
    expect(url).toBe("https://u:p@bridge.example.org/simplefin");
    expect(seen.url).toBe("https://bridge.example.org/simplefin/claim/ABC");
    expect(seen.init?.method).toBe("POST");
  });
  it("explains a 403 as an already-used or compromised token", async () => {
    await expect(claimAccessUrl(token, stubFetch(403, ""))).rejects.toThrow(/already used|compromised/);
  });
  it("rejects an access URL without credentials", async () => {
    await expect(claimAccessUrl(token, stubFetch(200, "https://bridge.example.org/simplefin"))).rejects.toThrow(
      SimplefinError
    );
  });
});

describe("fetchAccountSet", () => {
  it("moves URL credentials into a Basic auth header and sets start-date", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const start = new Date("2026-09-01T00:00:00Z");
    const set = await fetchAccountSet(
      "https://us%40r:p%3Ass@bridge.example.org/simplefin",
      start,
      stubFetch(200, JSON.stringify({ errors: ["hi"], accounts: [] }), seen)
    );
    expect(set).toEqual({ errors: ["hi"], accounts: [] });
    const url = new URL(seen.url!);
    expect(url.username).toBe("");
    expect(url.pathname).toBe("/simplefin/accounts");
    expect(url.searchParams.get("start-date")).toBe(String(start.getTime() / 1000));
    const auth = (seen.init?.headers as Record<string, string>).authorization;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe("us@r:p:ss");
  });
  it("turns a network failure into a readable error", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(fetchAccountSet("https://u:p@x.org/s", new Date(), down)).rejects.toThrow(/Couldn't reach SimpleFIN/);
  });
  it("maps 403 and 402 to readable errors", async () => {
    await expect(fetchAccountSet("https://u:p@x.org/s", new Date(), stubFetch(403, ""))).rejects.toThrow(/revoked/);
    await expect(fetchAccountSet("https://u:p@x.org/s", new Date(), stubFetch(402, ""))).rejects.toThrow(/payment/);
  });
});

describe("guessKind / owedFrom", () => {
  it("treats negative balances and card/loan names as debt", () => {
    expect(guessKind("Chequing", -20)).toBe("debt");
    expect(guessKind("Cash Back Visa", 450)).toBe("debt");
    expect(guessKind("Line of Credit", 0)).toBe("debt");
    expect(guessKind("Mastercard", 10)).toBe("debt");
  });
  it("treats positive, plainly named accounts as cash", () => {
    expect(guessKind("Everyday Chequing", 1200)).toBe("cash");
    expect(guessKind("High Interest Savings", 0)).toBe("cash");
  });
  it("reports the owed amount whichever sign the bank uses", () => {
    expect(owedFrom(-512.345)).toBe(512.35);
    expect(owedFrom(512.34)).toBe(512.34);
  });
});

describe("sanitizeMessage", () => {
  it("strips markup and control characters and caps length", () => {
    expect(sanitizeMessage("<b>Connection</b> needs\u0007 attention")).toBe("Connection needs attention");
    expect(sanitizeMessage("x".repeat(500))).toHaveLength(300);
  });
});

describe("encryption key check", () => {
  const original = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  afterEach(() => {
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = original;
  });
  const hex = "0".repeat(64);

  it("accepts a key pasted with quotes or whitespace", () => {
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = ` "${hex}" `;
    expect(encryptionKeyError()).toBeNull();
  });
  it("explains a missing or malformed key", () => {
    delete process.env.PLAID_TOKEN_ENCRYPTION_KEY;
    expect(encryptionKeyError()).toMatch(/not set/);
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = "abc123";
    expect(encryptionKeyError()).toMatch(/64 hex characters/);
  });
  it("never claims the single-use token when the key is unusable", async () => {
    delete process.env.PLAID_TOKEN_ENCRYPTION_KEY;
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("https://u:p@x.org/s");
    }) as typeof fetch;
    await expect(createConnection("u1", b64("https://x.org/claim/1"), spy)).rejects.toThrow(/Server setup incomplete/);
    expect(called).toBe(false);
  });
});

describe("claimAccessUrl response handling", () => {
  it("rejects a non-URL response body with a readable error", async () => {
    await expect(claimAccessUrl(b64("https://x.org/claim/1"), stubFetch(200, "<html>oops</html>"))).rejects.toThrow(
      /unexpected response/
    );
  });
});

describe("transactionDate", () => {
  const now = new Date("2026-09-23T15:00:00Z");
  const epoch = (iso: string) => Date.parse(iso) / 1000;
  const monthIn = (d: Date, timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).format(d);

  it("keeps a 1st-of-month posting (midnight UTC) in that month in Canada", () => {
    const d = transactionDate({ posted: epoch("2026-09-01T00:00:00Z") }, now);
    expect(d.toISOString()).toBe("2026-09-01T12:00:00.000Z");
    for (const tz of ["America/Vancouver", "America/Toronto", "America/Halifax", "America/St_Johns"])
      expect(monthIn(d, tz)).toBe("2026-09");
  });
  it("keeps an end-of-month posting in that month", () => {
    const d = transactionDate({ posted: epoch("2026-08-31T00:00:00Z") }, now);
    expect(monthIn(d, "America/Toronto")).toBe("2026-08");
  });
  it("prefers when it was transacted over when it posted", () => {
    const d = transactionDate({ posted: epoch("2026-09-02T00:00:00Z"), transacted_at: epoch("2026-08-30T00:00:00Z") }, now);
    expect(d.toISOString()).toBe("2026-08-30T12:00:00.000Z");
  });
  it("falls back to now for a missing date and never dates into the future", () => {
    expect(transactionDate({ posted: 0 }, now)).toBe(now);
    expect(transactionDate({ posted: epoch("2026-09-24T00:00:00Z") }, now)).toBe(now);
    const early = new Date("2026-09-23T08:00:00Z"); // before today's noon UTC
    expect(transactionDate({ posted: epoch("2026-09-23T00:00:00Z") }, early)).toBe(early);
  });
});
