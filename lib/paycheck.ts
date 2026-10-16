// Estimates one paycheque for an hourly employee working in Yellowknife
// (Northwest Territories), following the CRA's payroll method (T4127
// "Payroll Deductions Formulas", 122nd edition, effective January 1, 2026):
// the pay is annualized, taxed at the annual federal and territorial rates
// less the non-refundable credits, and the result divided back over the pay
// periods. Same approach the CRA's PDOC calculator and payroll software use,
// so the estimate lands close to a real pay stub; the exact figure still
// depends on the employee's TD1 claims and the employer's setup.
//
// The July 1, 2026 (123rd) edition only changed BC, Newfoundland and PEI;
// federal, NWT, CPP and EI values are the January ones below. Update these
// each January.

export const PAY_PERIODS = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 } as const;
export type PayFrequency = keyof typeof PAY_PERIODS;

// --- 2026 constants -------------------------------------------------------
const FED_BRACKETS: [upTo: number, rate: number][] = [
  [58_523, 0.14],
  [117_045, 0.205],
  [181_440, 0.26],
  [258_482, 0.29],
  [Infinity, 0.33],
];
const FED_CREDIT_RATE = 0.14; // lowest federal rate, used for credits
const FED_BPA_MAX = 16_452;
const FED_BPA_MIN = 14_829;
const FED_BPA_PHASE_START = 181_440;
const FED_BPA_PHASE_END = 258_482;
// Canada employment amount: 2025's $1,471 indexed by the 2026 factor (1.02).
const CANADA_EMPLOYMENT_AMOUNT = 1_501;

const NT_BRACKETS: [upTo: number, rate: number][] = [
  [53_003, 0.059],
  [106_009, 0.086],
  [172_346, 0.122],
  [Infinity, 0.1405],
];
const NT_CREDIT_RATE = 0.059;
const NT_BPA = 18_198;

const CPP_RATE = 0.0595;
const CPP_BASE_RATE = 0.0495; // the part that earns a tax credit
const CPP_FIRST_ADDITIONAL_RATE = 0.01; // the part that's deducted from income
const CPP_EXEMPTION = 3_500;
const YMPE = 74_600;
const CPP_MAX = 4_230.45;
const CPP_BASE_MAX = 3_519.45;
const CPP2_RATE = 0.04;
const YAMPE = 85_000;
const CPP2_MAX = 416;

const EI_RATE = 0.0163;
const EI_MAX_INSURABLE = 68_900;
const EI_MAX = 1_123.07;

// NWT payroll tax: 2% of employment income earned in the territory,
// withheld from the employee's pay (unlike provinces' employer-paid
// payroll taxes).
const NT_PAYROLL_TAX_RATE = 0.02;

// Northern residents deduction, claimed on the TD1 for Zone A (Yellowknife):
// $11/day basic + $11/day additional residency amount.
const NORTHERN_DEDUCTION_PER_YEAR = 22 * 365;

// --------------------------------------------------------------------------

export type PaycheckInput = {
  hourlyRate: number;
  overtimeRate: number;
  regularHours: number; // this pay period
  overtimeHours: number; // this pay period
  payFrequency: PayFrequency;
  // Gross earned so far this calendar year before this cheque (the "YTD"
  // line on the last pay stub). Lets CPP, CPP2 and EI stop at their yearly
  // maximums the way real payroll does; 0 assumes none have been reached.
  ytdGross?: number | null;
  // Taken off after tax (benefits, union dues…). Doesn't change the tax.
  otherDeductions?: number;
  // Claimed the northern residents deduction on the TD1.
  northernDeduction?: boolean;
};

export type PaycheckEstimate = {
  regularPay: number;
  overtimePay: number;
  gross: number;
  federalTax: number;
  territorialTax: number;
  cpp: number;
  cpp2: number;
  ei: number;
  payrollTax: number;
  other: number;
  totalDeductions: number;
  net: number;
  cppMaxed: boolean;
  eiMaxed: boolean;
};

const cents = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function progressiveTax(income: number, brackets: [number, number][]): number {
  let tax = 0;
  let from = 0;
  for (const [upTo, rate] of brackets) {
    if (income <= from) break;
    tax += (Math.min(income, upTo) - from) * rate;
    from = upTo;
  }
  return tax;
}

// The federal basic personal amount shrinks for incomes over $181,440.
export function federalBpa(netIncome: number): number {
  if (netIncome <= FED_BPA_PHASE_START) return FED_BPA_MAX;
  if (netIncome >= FED_BPA_PHASE_END) return FED_BPA_MIN;
  const share = (netIncome - FED_BPA_PHASE_START) / (FED_BPA_PHASE_END - FED_BPA_PHASE_START);
  return FED_BPA_MAX - (FED_BPA_MAX - FED_BPA_MIN) * share;
}

export function estimatePaycheck(input: PaycheckInput): PaycheckEstimate {
  const P = PAY_PERIODS[input.payFrequency];
  const regularPay = cents(Math.max(0, input.hourlyRate) * Math.max(0, input.regularHours));
  const overtimePay = cents(Math.max(0, input.overtimeRate) * Math.max(0, input.overtimeHours));
  const gross = cents(regularPay + overtimePay);
  const ytd = Math.max(0, input.ytdGross ?? 0);
  const other = cents(Math.max(0, input.otherDeductions ?? 0));

  // CPP: 5.95% of pay over the per-period share of the $3,500 exemption,
  // until the yearly maximum. What's already been paid is estimated from
  // year-to-date earnings, spreading the exemption over the cheques so far.
  const chequesSoFar = gross > 0 ? Math.min(P, ytd / gross) : 0;
  const ytdCpp = clamp(CPP_RATE * (Math.min(ytd, YMPE) - (CPP_EXEMPTION * chequesSoFar) / P), 0, CPP_MAX);
  const cppRoom = CPP_MAX - ytdCpp;
  const cpp = cents(clamp(CPP_RATE * (gross - CPP_EXEMPTION / P), 0, cppRoom));
  // CPP2: 4% on earnings between the YMPE and the YAMPE, once the year's
  // earnings pass the YMPE.
  const cpp2Band = Math.max(0, Math.min(ytd + gross, YAMPE) - Math.max(ytd, YMPE));
  const cpp2 = cents(Math.min(CPP2_RATE * cpp2Band, CPP2_MAX));
  // EI: 1.63% of pay, until the yearly maximum.
  const eiRoom = Math.max(0, EI_MAX - EI_RATE * Math.min(ytd, EI_MAX_INSURABLE));
  const ei = cents(Math.min(EI_RATE * gross, eiRoom));
  const payrollTax = cents(NT_PAYROLL_TAX_RATE * gross);

  // Annual taxable income (T4127 "A"): the enhanced part of CPP and all of
  // CPP2 are deducted from income; the northern deduction comes off too.
  const hd = input.northernDeduction ? NORTHERN_DEDUCTION_PER_YEAR : 0;
  const f5 = cpp * (CPP_FIRST_ADDITIONAL_RATE / CPP_RATE) + cpp2;
  const annualIncome = Math.max(0, P * (gross - f5) - hd);

  // Credits use this cheque's contributions annualized (capped at the
  // yearly base maximums), as payroll does — so once CPP/EI stop for the
  // year, tax per cheque edges up slightly.
  const annualBaseCpp = Math.min(P * cpp * (CPP_BASE_RATE / CPP_RATE), CPP_BASE_MAX);
  const annualEi = Math.min(P * ei, EI_MAX);

  const federalCredits =
    FED_CREDIT_RATE *
    (federalBpa(annualIncome + hd) + annualBaseCpp + annualEi + Math.min(annualIncome, CANADA_EMPLOYMENT_AMOUNT));
  const federalAnnual = Math.max(0, progressiveTax(annualIncome, FED_BRACKETS) - federalCredits);

  const territorialCredits = NT_CREDIT_RATE * (NT_BPA + annualBaseCpp + annualEi);
  const territorialAnnual = Math.max(0, progressiveTax(annualIncome, NT_BRACKETS) - territorialCredits);

  const federalTax = cents(federalAnnual / P);
  const territorialTax = cents(territorialAnnual / P);
  const totalDeductions = cents(federalTax + territorialTax + cpp + cpp2 + ei + payrollTax + other);

  return {
    regularPay,
    overtimePay,
    gross,
    federalTax,
    territorialTax,
    cpp,
    cpp2,
    ei,
    payrollTax,
    other,
    totalDeductions,
    net: cents(gross - totalDeductions),
    cppMaxed: gross > 0 && cppRoom <= 0.005,
    eiMaxed: gross > 0 && eiRoom <= 0.005,
  };
}
