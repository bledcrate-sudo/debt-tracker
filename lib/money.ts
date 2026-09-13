// Storage is Float, which can't represent every decimal exactly — rounding at
// every write boundary keeps stored amounts to whole cents so drift can't
// accumulate from user input. This doesn't eliminate float arithmetic error
// in aggregation (a Decimal/cents-as-integer schema would), but it keeps what
// gets stored honest.
export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}
