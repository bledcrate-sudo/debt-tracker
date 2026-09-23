import { describe, it, expect } from "vitest";
import { findTransferPairs, classifyTxn, type BankTxn } from "./bank-import";

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

describe("classifyTxn", () => {
  const c = (amount: number, label: string) => classifyTxn({ amount, label });

  it("counts pay and deposits as income", () => {
    expect(c(2100, "PAYROLL DEPOSIT ACME CORP")).toBe("income");
    expect(c(2100, "Deposit from ACME PAYROLL")).toBe("income");
    expect(c(1800, "ACME CORP PAY")).toBe("income");
    expect(c(950, "DIRECT DEP CANADA")).toBe("income");
    expect(c(300, "MOBILE CHEQUE DEPOSIT")).toBe("income");
    expect(c(1200, "SALARY SEPT")).toBe("income");
  });

  it("puts e-transfers in circulation, either direction", () => {
    expect(c(60, "INTERAC E-TRANSFER FROM SAM")).toBe("circulation");
    expect(c(60, "E-TRANSFER DEPOSIT SAM")).toBe("circulation");
    expect(c(60, "Autodeposit from Sam")).toBe("circulation");
    expect(c(-45, "SEND E-TFR ***4XZ")).toBe("circulation");
    expect(c(-45, "Interac e-Transfer To: Alex")).toBe("circulation");
  });

  it("puts other money in (refunds etc.) in circulation, not income", () => {
    expect(c(25, "AMAZON.CA REFUND")).toBe("circulation");
    expect(c(12, "APPLE PAY RETURN")).toBe("circulation");
    expect(c(3.2, "INTEREST PAID")).toBe("circulation");
  });

  it("puts card and loan payments in circulation, spending in purchases", () => {
    expect(c(-400, "PAYMENT - VISA TD")).toBe("circulation");
    expect(c(-400, "MASTERCARD PAYMENT")).toBe("circulation");
    expect(c(-250, "LOAN PMT 1234")).toBe("circulation");
    expect(c(-12.5, "TIM HORTONS #123")).toBe("purchase");
    expect(c(-80, "HYDRO ONE PAYMENT")).toBe("purchase");
    expect(c(-9.99, "NETFLIX.COM")).toBe("purchase");
  });

  it("treats TD's VFC-prefixed transactions as e-transfers (circulation), not income", () => {
    const td = (amount: number, label: string, institution: string | null = "TD Canada Trust", hint?: "income") =>
      classifyTxn({ amount, label, institution, hint });
    expect(td(250, "VFC1234567 DEPOSIT")).toBe("circulation");
    expect(td(250, "vfc SAM SMITH")).toBe("circulation");
    expect(td(-80, "VFC SEND ALEX")).toBe("circulation");
    expect(td(250, "VFC1234567", "TD Bank")).toBe("circulation");
    expect(td(250, "VFC1234567", "The Toronto-Dominion Bank")).toBe("circulation");
    expect(td(250, "VFC1234567", null)).toBe("circulation"); // bank unknown
    expect(td(250, "VFC1234567", "TD Canada Trust", "income")).toBe("circulation"); // beats Plaid's category
    // Only at the start, and only for TD.
    expect(td(2100, "PAYROLL DEPOSIT VFC CORP")).toBe("income");
    expect(td(2100, "VFC PAYROLL", "EQ Bank")).toBe("income");
  });

  it("uses the provider's category when it has one", () => {
    expect(classifyTxn({ amount: 500, label: "MISC", hint: "income" })).toBe("income");
  });
});
