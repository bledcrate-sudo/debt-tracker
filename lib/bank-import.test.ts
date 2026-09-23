import { describe, it, expect } from "vitest";
import { findTransferPairs, type BankTxn } from "./bank-import";

const day = (d: number) => new Date(Date.UTC(2026, 8, d, 12));
const txn = (key: string, account: string, amount: number, d: number, label = key): BankTxn => ({
  key,
  account,
  amount,
  date: day(d),
  label,
});

describe("findTransferPairs", () => {
  it("pairs money moved from chequing to savings", () => {
    const pairs = findTransferPairs([txn("out", "chq", -500, 10), txn("in", "sav", 500, 11)]);
    expect(pairs.get("out")).toBe("in");
    expect(pairs.get("in")).toBe("out");
  });

  it("leaves real income and spending alone", () => {
    const pairs = findTransferPairs([
      txn("pay", "chq", 2100, 15, "PAYROLL"),
      txn("etr", "chq", 60, 16, "E-TRANSFER FROM SAM"),
      txn("coffee", "chq", -4.5, 16),
    ]);
    expect(pairs.size).toBe(0);
  });

  it("doesn't pair within the same account, different amounts, or far-apart dates", () => {
    expect(findTransferPairs([txn("a", "chq", -50, 10), txn("b", "chq", 50, 10)]).size).toBe(0); // refund
    expect(findTransferPairs([txn("a", "chq", -50, 10), txn("b", "sav", 50.01, 10)]).size).toBe(0);
    expect(findTransferPairs([txn("a", "chq", -50, 1), txn("b", "sav", 50, 9)]).size).toBe(0);
  });

  it("pairs each side at most once", () => {
    const pairs = findTransferPairs([
      txn("out1", "chq", -100, 10),
      txn("out2", "chq", -100, 10),
      txn("in1", "sav", 100, 10),
    ]);
    expect(pairs.size).toBe(2);
    expect(pairs.get("out1")).toBe("in1");
    expect(pairs.has("out2")).toBe(false);
  });
});
