import { describe, it, expect } from "vitest";
import { estimatePaycheck, federalBpa, splitPaycheck, splitPaycheckWithDebt, perCheque, DEFAULT_SPLIT, type PaycheckInput } from "./paycheck";

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

describe("splitPaycheck", () => {
  it("splits $2,000 50/15/5/30 like the picture", () => {
    const s = splitPaycheck(2000, DEFAULT_SPLIT);
    expect(s.parts).toEqual({ mustHaves: 1000, retirement: 300, emergency: 100, couldHaves: 600 });
    expect(s.placed).toBe(2000);
    expect(s.unplaced).toBe(0);
  });

  it("places every cent even when the amount doesn't divide evenly", () => {
    for (const amount of [1855.7, 2297.73, 0.01, 999.99, 1234.57]) {
      const s = splitPaycheck(amount, DEFAULT_SPLIT);
      const sum = Object.values(s.parts).reduce((a, b) => a + b, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(amount * 100));
      expect(s.unplaced).toBe(0);
    }
  });

  it("shows what's left to place when the percentages add up to less than 100", () => {
    const s = splitPaycheck(1000, { mustHaves: 50, retirement: 10, emergency: 5, couldHaves: 20 });
    expect(s.totalPct).toBe(85);
    expect(s.placed).toBe(850);
    expect(s.unplaced).toBe(150);
  });

  it("goes negative when they add up to more than 100", () => {
    const s = splitPaycheck(1000, { mustHaves: 60, retirement: 15, emergency: 5, couldHaves: 30 });
    expect(s.totalPct).toBe(110);
    expect(s.unplaced).toBe(-100);
  });

  it("handles nothing to split", () => {
    expect(splitPaycheck(0, DEFAULT_SPLIT).placed).toBe(0);
  });
});

describe("debt in the paycheck split", () => {
  it("spreads a monthly payment over the cheques in a year", () => {
    expect(perCheque(900, "biweekly")).toBe(415.38); // 900 × 12 / 26
    expect(perCheque(900, "weekly")).toBe(207.69);
    expect(perCheque(900, "semimonthly")).toBe(450);
    expect(perCheque(900, "monthly")).toBe(900);
  });

  it("takes debt off the top and splits the rest", () => {
    const s = splitPaycheckWithDebt(2000, 400, DEFAULT_SPLIT);
    expect(s.debt).toBe(400);
    expect(s.afterDebt).toBe(1600);
    expect(s.parts).toEqual({ mustHaves: 800, retirement: 240, emergency: 80, couldHaves: 480 });
    expect(s.placed).toBe(2000);
    expect(s.unplaced).toBe(0);
  });

  it("still places every cent with an uneven debt payment", () => {
    const s = splitPaycheckWithDebt(1855.7, 415.38, DEFAULT_SPLIT);
    const sum = s.debt + Object.values(s.parts).reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 100)).toBe(185570);
    expect(s.unplaced).toBe(0);
  });

  it("flags a debt payment bigger than the cheque", () => {
    const s = splitPaycheckWithDebt(500, 800, DEFAULT_SPLIT);
    expect(s.debt).toBe(500);
    expect(s.debtShort).toBe(300);
    expect(s.afterDebt).toBe(0);
    expect(s.placed).toBe(500);
  });

  it("is the plain split with no debt", () => {
    expect(splitPaycheckWithDebt(2000, 0, DEFAULT_SPLIT).parts).toEqual(splitPaycheck(2000, DEFAULT_SPLIT).parts);
  });
});
