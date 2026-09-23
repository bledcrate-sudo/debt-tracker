import { describe, it, expect } from "vitest";
import { guessCategory } from "./categorize";

describe("guessCategory", () => {
  it("recognizes groceries", () => {
    expect(guessCategory("SUPERSTORE #1520")).toBe("Groceries");
    expect(guessCategory("Sobeys #123")).toBe("Groceries");
    expect(guessCategory("Costco Wholesale #540")).toBe("Groceries");
  });

  it("recognizes dining", () => {
    expect(guessCategory("TIM HORTONS #121")).toBe("Dining");
    expect(guessCategory("Uber Eats")).toBe("Dining");
    expect(guessCategory("Starbucks Coffee")).toBe("Dining");
  });

  it("recognizes gas and transport, distinct from Uber Eats", () => {
    expect(guessCategory("SHELL C04221")).toBe("Gas & Transport");
    expect(guessCategory("Uber Trip")).toBe("Gas & Transport");
    expect(guessCategory("Petro-Canada")).toBe("Gas & Transport");
  });

  it("recognizes subscriptions, distinct from one-off shopping", () => {
    expect(guessCategory("NETFLIX.COM")).toBe("Subscriptions");
    expect(guessCategory("SPOTIFY P1A2B3")).toBe("Subscriptions");
    expect(guessCategory("Amazon Prime Membership")).toBe("Subscriptions");
    expect(guessCategory("AMAZON.CA*A1B2C3")).toBe("Shopping");
  });

  it("recognizes bills and utilities", () => {
    expect(guessCategory("HYDRO ONE PAYMENT")).toBe("Bills & Utilities");
    expect(guessCategory("Rogers Communications")).toBe("Bills & Utilities");
  });

  it("recognizes health, entertainment and travel", () => {
    expect(guessCategory("Shoppers Drug Mart")).toBe("Health");
    expect(guessCategory("Cineplex Cinemas")).toBe("Entertainment");
    expect(guessCategory("Air Canada")).toBe("Travel");
  });

  it("falls back to Other for anything unrecognized", () => {
    expect(guessCategory("SOME RANDOM MERCHANT 99231")).toBe("Other");
  });
});
