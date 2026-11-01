import { describe, it, expect } from "vitest";
import { planChallenge, nextPaymentDate, daysBetween, todayIn, type ChallengeDebt, type ChallengeSettings } from "./debt-challenge";

const card: ChallengeDebt = { id: "visa", label: "Visa", balance: 1000, apr: 0, minPayment: 50 };
const settings = (o: Partial<ChallengeSettings> = {}): ChallengeSettings => ({
  monthlyAmount: 250,
  strategy: "avalanche",
  payDay: 15,
  startDebt: 1000,
  targetDate: null,
  ...o,
});

describe("nextPaymentDate", () => {
  it("is this month's pay day when it hasn't passed yet, else next month's", () => {
    expect(nextPaymentDate("2026-11-01", 15)).toBe("2026-11-15");
    expect(nextPaymentDate("2026-11-15", 15)).toBe("2026-11-15");
    expect(nextPaymentDate("2026-11-16", 15)).toBe("2026-12-15");
    expect(nextPaymentDate("2026-12-20", 1)).toBe("2027-01-01");
  });
  it("keeps pay days to 1–28 so every month has one", () => {
    expect(nextPaymentDate("2027-02-01", 31)).toBe("2027-02-28");
  });
});

describe("planChallenge", () => {
  it("pays $1,000 at 0% off in 4 payments of $250, on the 4th pay date", () => {
    const r = planChallenge([card], settings(), "2026-11-01");
    expect(r.monthsLeft).toBe(4);
    expect(r.nextPaymentDate).toBe("2026-11-15");
    expect(r.debtFreeDate).toBe("2027-02-15");
    expect(r.daysLeft).toBe(daysBetween("2026-11-01", "2027-02-15"));
    expect(r.order[0].payoffDate).toBe("2027-02-15");
  });

  it("counts down one day at a time between payments", () => {
    const a = planChallenge([card], settings(), "2026-11-01");
    const b = planChallenge([card], settings(), "2026-11-02");
    expect(a.debtFreeDate).toBe(b.debtFreeDate);
    expect(b.daysLeft).toBe(a.daysLeft! - 1);
  });

  it("keeps the same date after a payment lands on schedule", () => {
    const before = planChallenge([card], settings(), "2026-11-10");
    const after = planChallenge([{ ...card, balance: 750 }], settings(), "2026-11-16");
    expect(after.debtFreeDate).toBe(before.debtFreeDate);
    expect(after.paidOff).toBe(250);
    expect(after.progress).toBeCloseTo(0.25);
  });

  it("reports days ahead of the promised date when paying more", () => {
    const target = planChallenge([card], settings(), "2026-11-01").debtFreeDate!;
    const r = planChallenge([card], settings({ monthlyAmount: 500, targetDate: target }), "2026-11-01");
    expect(r.debtFreeDate).toBe("2026-12-15");
    expect(r.daysAhead).toBe(daysBetween("2026-12-15", target));
    expect(r.daysAhead!).toBeGreaterThan(0);
  });

  it("includes interest, so a high APR takes longer", () => {
    const cheap = planChallenge([card], settings(), "2026-11-01");
    const pricey = planChallenge([{ ...card, apr: 24 }], settings(), "2026-11-01");
    expect(pricey.monthsLeft!).toBeGreaterThan(cheap.monthsLeft!);
    expect(pricey.totalInterest!).toBeGreaterThan(0);
  });

  it("returns no date when the payment never beats the interest", () => {
    const r = planChallenge([{ ...card, balance: 10_000, apr: 30, minPayment: 0 }], settings({ monthlyAmount: 100 }), "2026-11-01");
    expect(r.debtFreeDate).toBeNull();
    expect(r.daysLeft).toBeNull();
  });

  it("flags a monthly amount below the minimums", () => {
    const r = planChallenge([card, { ...card, id: "loan", minPayment: 300 }], settings({ monthlyAmount: 200 }), "2026-11-01");
    expect(r.totalMin).toBe(350);
    expect(r.belowMinimums).toBe(true);
  });

  it("orders debts by APR for avalanche and by balance for snowball", () => {
    const debts: ChallengeDebt[] = [
      { id: "small", label: "Small", balance: 300, apr: 10, minPayment: 25 },
      { id: "pricey", label: "Pricey", balance: 3000, apr: 25, minPayment: 60 },
    ];
    expect(planChallenge(debts, settings({ monthlyAmount: 500 }), "2026-11-01").order[0].id).toBe("pricey");
    expect(planChallenge(debts, settings({ monthlyAmount: 500, strategy: "snowball" }), "2026-11-01").order[0].id).toBe("small");
  });

  it("is done with nothing left to pay", () => {
    const r = planChallenge([{ ...card, balance: 0 }], settings(), "2026-11-01");
    expect(r.done).toBe(true);
    expect(r.daysLeft).toBe(0);
    expect(r.progress).toBe(1);
  });
});

describe("todayIn", () => {
  it("uses the given timezone's calendar date", () => {
    const lateEvening = new Date("2026-11-02T04:30:00Z"); // still Nov 1 in Yellowknife
    expect(todayIn("America/Edmonton", lateEvening)).toBe("2026-11-01");
    expect(todayIn("UTC", lateEvening)).toBe("2026-11-02");
  });
});
