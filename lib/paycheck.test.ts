import { describe, it, expect } from "vitest";
import { estimatePaycheck, federalBpa, type PaycheckInput } from "./paycheck";

const base: PaycheckInput = {
  hourlyRate: 30,
  overtimeRate: 45,
  regularHours: 80,
  overtimeHours: 0,
  payFrequency: "biweekly",
};

describe("estimatePaycheck (Yellowknife, 2026)", () => {
  it("matches a hand-worked T4127 calculation for $30/h × 80h biweekly", () => {
    // Worked by hand from the CRA formulas:
    //   CPP  = 5.95% × (2400 − 3500/26)                       = 134.79
    //   EI   = 1.63% × 2400                                   =  39.12
    //   NWT payroll tax = 2% × 2400                           =  48.00
    //   A    = 26 × (2400 − 134.79 × 1/5.95)                  ≈ 61,811
    //   Fed  = (14% × 58,523 + 20.5% × 3,288 − 14% × (16,452 + 2,915.56 + 1,017.12 + 1,501)) / 26 ≈ 223.20
    //   NWT  = (5.9% × 53,003 + 8.6% × 8,808 − 5.9% × (18,198 + 2,915.56 + 1,017.12)) / 26 ≈ 99.19
    const p = estimatePaycheck(base);
    expect(p.gross).toBe(2400);
    expect(p.cpp).toBeCloseTo(134.79, 2);
    expect(p.ei).toBeCloseTo(39.12, 2);
    expect(p.payrollTax).toBeCloseTo(48, 2);
    expect(p.federalTax).toBeCloseTo(223.2, 1);
    expect(p.territorialTax).toBeCloseTo(99.19, 1);
    expect(p.cpp2).toBe(0);
    expect(p.net).toBeCloseTo(1855.7, 0);
    expect(p.net).toBeCloseTo(p.gross - p.totalDeductions, 2);
  });

  it("adds overtime pay at the overtime rate", () => {
    const p = estimatePaycheck({ ...base, overtimeHours: 10 });
    expect(p.regularPay).toBe(2400);
    expect(p.overtimePay).toBe(450);
    expect(p.gross).toBe(2850);
    expect(p.net).toBeGreaterThan(estimatePaycheck(base).net);
  });

  it("lowers tax with the northern residents deduction", () => {
    const without = estimatePaycheck(base);
    const withIt = estimatePaycheck({ ...base, northernDeduction: true });
    expect(withIt.federalTax + withIt.territorialTax).toBeLessThan(without.federalTax + without.territorialTax);
    // CPP, EI and the payroll tax don't change.
    expect(withIt.cpp).toBe(without.cpp);
    expect(withIt.ei).toBe(without.ei);
    expect(withIt.payrollTax).toBe(without.payrollTax);
  });

  it("stops EI once the year's insurable earnings pass the maximum", () => {
    const p = estimatePaycheck({ ...base, ytdGross: 70_000 });
    expect(p.ei).toBe(0);
    expect(p.eiMaxed).toBe(true);
  });

  it("takes only the EI left for the year on the cheque that crosses the maximum", () => {
    const p = estimatePaycheck({ ...base, ytdGross: 68_000 });
    expect(p.ei).toBeCloseTo(0.0163 * 900, 2); // 68,900 − 68,000
  });

  it("switches from CPP to CPP2 once earnings pass the YMPE", () => {
    const p = estimatePaycheck({ ...base, ytdGross: 76_000 });
    expect(p.cpp).toBe(0);
    expect(p.cppMaxed).toBe(true);
    expect(p.cpp2).toBeCloseTo(0.04 * 2400, 2);
  });

  it("charges CPP2 only on the part of the cheque above the YMPE", () => {
    const p = estimatePaycheck({ ...base, ytdGross: 74_000 });
    expect(p.cpp2).toBeCloseTo(0.04 * (76_400 - 74_600), 2);
  });

  it("stops CPP2 above the YAMPE", () => {
    expect(estimatePaycheck({ ...base, ytdGross: 90_000 }).cpp2).toBe(0);
  });

  it("returns zeros for no hours", () => {
    const p = estimatePaycheck({ ...base, regularHours: 0 });
    expect(p.gross).toBe(0);
    expect(p.net).toBe(0);
    expect(p.totalDeductions).toBe(0);
  });

  it("subtracts other deductions after tax without changing the tax", () => {
    const plain = estimatePaycheck(base);
    const p = estimatePaycheck({ ...base, otherDeductions: 50 });
    expect(p.federalTax).toBe(plain.federalTax);
    expect(p.net).toBeCloseTo(plain.net - 50, 2);
  });

  it("taxes weekly pay the same per year as biweekly", () => {
    const weekly = estimatePaycheck({ ...base, regularHours: 40, payFrequency: "weekly" });
    const biweekly = estimatePaycheck(base);
    expect(weekly.federalTax * 2).toBeCloseTo(biweekly.federalTax, 0);
    expect(weekly.territorialTax * 2).toBeCloseTo(biweekly.territorialTax, 0);
  });
});

describe("federalBpa", () => {
  it("is the full amount up to $181,440 and phases down to the minimum", () => {
    expect(federalBpa(100_000)).toBe(16_452);
    expect(federalBpa(300_000)).toBe(14_829);
    expect(federalBpa((181_440 + 258_482) / 2)).toBeCloseTo((16_452 + 14_829) / 2, 0);
  });
});
