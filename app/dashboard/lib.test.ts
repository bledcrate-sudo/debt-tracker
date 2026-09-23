import { describe, it, expect } from "vitest";
import {
  daysUntilDue,
  paidSinceLastDue,
  bornIn,
  activeIn,
  simulatePayoff,
  buildSuggestions,
  anchorLedger,
  type SimDebt,
  type Entry,
} from "./lib";

function makeDebt(overrides: Partial<SimDebt> = {}): SimDebt {
  return {
    id: "d1",
    type: "debt",
    label: "Card",
    amount: 1000,
    frequency: "once",
    note: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    payments: [],
    debtPayments: [],
    ...overrides,
  };
}

describe("daysUntilDue", () => {
  it("counts days within the current month", () => {
    const now = new Date(2026, 2, 10); // March 10
    expect(daysUntilDue(15, now)).toBe(5);
  });

  it("wraps to next month once the day has passed", () => {
    const now = new Date(2026, 2, 20); // March 20
    // Next occurrence is April 5 -> 11 days left in March + 5 = 16
    expect(daysUntilDue(5, now)).toBe(16);
  });

  it("clamps a day-31 due date to February's last day", () => {
    const now = new Date(2026, 1, 20); // Feb 20, 2026 (28-day Feb)
    expect(daysUntilDue(31, now)).toBe(8); // Feb 28 - Feb 20
  });
});

describe("paidSinceLastDue", () => {
  it("is false with no payments", () => {
    expect(paidSinceLastDue(15, [], new Date(2026, 2, 20))).toBe(false);
  });

  it("is true once a payment lands on/after the most recent due date", () => {
    const now = new Date(2026, 2, 20); // March 20; last due date was March 15
    const payments = [{ kind: "payment", paidAt: "2026-03-16T00:00:00.000Z" }];
    expect(paidSinceLastDue(15, payments, now)).toBe(true);
  });

  it("ignores a payment from before the most recent due date", () => {
    const now = new Date(2026, 2, 20);
    const payments = [{ kind: "payment", paidAt: "2026-02-10T00:00:00.000Z" }];
    expect(paidSinceLastDue(15, payments, now)).toBe(false);
  });

  it("ignores card usage (kind: charge), only counts payments", () => {
    const now = new Date(2026, 2, 20);
    const payments = [{ kind: "charge", paidAt: "2026-03-16T00:00:00.000Z" }];
    expect(paidSinceLastDue(15, payments, now)).toBe(false);
  });
});

describe("bornIn / activeIn", () => {
  const monthly: Entry = {
    id: "e1",
    type: "expense",
    label: "Rent",
    amount: 100,
    frequency: "monthly",
    note: null,
    createdAt: "2025-01-15T00:00:00.000Z",
    payments: [],
    debtPayments: [],
  };
  const once: Entry = { ...monthly, id: "e2", frequency: "once" };

  it("a monthly entry stays active in every month from its creation onward", () => {
    expect(bornIn(monthly)).toBe("2025-01");
    expect(activeIn(monthly, "2025-01")).toBe(true);
    expect(activeIn(monthly, "2025-06")).toBe(true);
    expect(activeIn(monthly, "2024-12")).toBe(false);
  });

  it("a one-off entry is only active the month it was logged", () => {
    expect(activeIn(once, "2025-01")).toBe(true);
    expect(activeIn(once, "2025-02")).toBe(false);
  });
});

describe("simulatePayoff", () => {
  it("clears a single debt in the expected number of months with no interest", () => {
    const debt = makeDebt({ amount: 300, apr: 0 });
    const plan = simulatePayoff([debt], "avalanche", 100);
    expect(plan.monthsToClear).toBe(3);
    expect(plan.totalInterest).toBe(0);
  });

  it("never finishes when payments don't cover accruing interest", () => {
    const debt = makeDebt({ amount: 10000, apr: 30, minPayment: 0 });
    const plan = simulatePayoff([debt], "avalanche", 1);
    expect(plan.monthsToClear).toBe(Infinity);
    expect(plan.totalInterest).toBe(Infinity);
  });

  it("avalanche attacks the highest-APR debt first", () => {
    const low = makeDebt({ id: "low-apr", amount: 500, apr: 5 });
    const high = makeDebt({ id: "high-apr", amount: 500, apr: 25 });
    const plan = simulatePayoff([low, high], "avalanche", 200);
    expect(plan.order[0].id).toBe("high-apr");
  });

  it("snowball attacks the smallest balance first", () => {
    const small = makeDebt({ id: "small", amount: 200, apr: 20 });
    const large = makeDebt({ id: "large", amount: 800, apr: 5 });
    const plan = simulatePayoff([large, small], "snowball", 200);
    expect(plan.order[0].id).toBe("small");
  });

  it("ignores debts that are already paid off", () => {
    const paidOff = makeDebt({ id: "done", amount: 0 });
    const owed = makeDebt({ id: "owed", amount: 100, apr: 0 });
    const plan = simulatePayoff([paidOff, owed], "avalanche", 100);
    expect(plan.order.map((d) => d.id)).toEqual(["owed"]);
  });
});

describe("buildSuggestions", () => {
  const base = {
    fmt: (n: number) => `$${n.toFixed(2)}`,
    totalIncome: 3000,
    expectedIncome: 3000,
    totalExpense: 1000,
    totalDebt: 5000,
    surplus: 500,
    dti: 0.1,
    monthsToClear: 12,
    debtCount: 1,
    biggestDebt: null,
    smallestDebt: null,
  };

  it("only prompts for income when none is logged yet", () => {
    const out = buildSuggestions({ ...base, expectedIncome: 0 });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Add your income first");
  });

  it("warns when spending exceeds income", () => {
    const out = buildSuggestions({ ...base, surplus: -200 });
    expect(out.some((s) => s.tone === "bad" && /spending more/i.test(s.title))).toBe(true);
  });

  it("flags a high debt-to-income ratio as bad", () => {
    const out = buildSuggestions({ ...base, dti: 0.5 });
    expect(out.some((s) => s.tone === "bad" && /debt-to-income/i.test(s.title))).toBe(true);
  });
});

describe("anchorLedger", () => {
  const rows = [
    { month: "2026-08", carryIn: 0, closing: 100, available: 100 },
    { month: "2026-09", carryIn: 100, closing: 250, available: 200 },
  ];
  it("makes the current month close at the real bank balance", () => {
    const out = anchorLedger(rows, "2026-09", 1750);
    expect(out[1]).toMatchObject({ carryIn: 1600, closing: 1750, available: 1700 });
  });
  it("works earlier months backwards by the same offset", () => {
    const out = anchorLedger(rows, "2026-09", 1750);
    expect(out[0]).toMatchObject({ carryIn: 1500, closing: 1600 });
    expect(out[0].closing).toBe(out[1].carryIn);
  });
});
