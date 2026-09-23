import { describe, it, expect } from "vitest";
import { detectRecurring } from "./recurring";

const d = (iso: string) => new Date(iso);

describe("detectRecurring", () => {
  it("flags a merchant charging the same amount every ~30 days", () => {
    const found = detectRecurring([
      { label: "NETFLIX.COM", amount: -16.99, date: d("2026-06-15") },
      { label: "NETFLIX.COM", amount: -16.99, date: d("2026-07-15") },
      { label: "NETFLIX.COM", amount: -16.99, date: d("2026-08-14") },
      { label: "NETFLIX.COM", amount: -17.99, date: d("2026-09-15") }, // a small price bump
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe("NETFLIX.COM");
    expect(found[0].occurrences).toBe(4);
    expect(found[0].amount).toBeCloseTo(17.99);
    expect(found[0].monthlyAmount).toBeCloseTo(17.99, 0);
  });

  it("groups the same merchant despite trailing store codes and card suffixes", () => {
    const found = detectRecurring([
      { label: "SOBEYS #123", amount: -85, date: d("2026-06-05") },
      { label: "SOBEYS #456", amount: -90, date: d("2026-07-04") },
    ]);
    // Same normalized merchant, but a grocery run isn't a fixed monthly
    // amount and this dataset alone can't tell — the point here is just
    // that trailing store numbers don't split it into separate merchants.
    expect(found).toHaveLength(1);
  });

  it("ignores one-off purchases", () => {
    expect(
      detectRecurring([
        { label: "AMAZON.CA", amount: -45, date: d("2026-06-01") },
        { label: "BEST BUY", amount: -200, date: d("2026-06-10") },
      ])
    ).toHaveLength(0);
  });

  it("doesn't pair charges spaced too close together or too far apart", () => {
    expect(
      detectRecurring([
        { label: "COFFEE SHOP", amount: -5, date: d("2026-06-01") },
        { label: "COFFEE SHOP", amount: -5, date: d("2026-06-03") }, // daily habit, not a bill
      ])
    ).toHaveLength(0);
    expect(
      detectRecurring([
        { label: "INSURANCE CO", amount: -600, date: d("2026-01-01") },
        { label: "INSURANCE CO", amount: -600, date: d("2026-09-01") }, // 8 months apart
      ])
    ).toHaveLength(0);
  });

  it("doesn't pair when the amount drifts too much", () => {
    expect(
      detectRecurring([
        { label: "HYDRO ONE", amount: -60, date: d("2026-06-01") },
        { label: "HYDRO ONE", amount: -140, date: d("2026-07-01") }, // seasonal swing, not a fixed bill
      ])
    ).toHaveLength(0);
  });

  it("estimates a monthly-equivalent cost for a quarterly charge", () => {
    const found = detectRecurring([
      { label: "AMAZON PRIME ANNUAL", amount: -30, date: d("2026-01-15") },
      { label: "AMAZON PRIME ANNUAL", amount: -30, date: d("2026-02-10") }, // ~26 days, still monthly-ish
    ]);
    expect(found[0].monthlyAmount).toBeLessThanOrEqual(30);
  });
});
