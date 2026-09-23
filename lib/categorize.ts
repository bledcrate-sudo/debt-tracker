// Guesses a spending category for a purchase from its description. Kept
// separate from classifyTxn (income/purchase/circulation): this only runs
// on purchases, purely to group them for the budget and the transactions
// feed, and is meant to be overridden per-transaction when it's wrong.
export const CATEGORIES = [
  "Groceries",
  "Dining",
  "Gas & Transport",
  "Shopping",
  "Bills & Utilities",
  "Subscriptions",
  "Health",
  "Entertainment",
  "Travel",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];

// Ordered rules: the first match wins, so more specific patterns (a named
// streaming service) are listed before the general ones they'd otherwise
// also match (e.g. "shop").
const RULES: [RegExp, Category][] = [
  [
    /superstore|loblaws|no frills|sobeys|metro\b|walmart supercentre|costco wholesale|freshco|food basics|safeway|save-on-foods|iga\b|whole foods|farm boy|grocery|butcher|bakery|produce/i,
    "Groceries",
  ],
  [
    /netflix|spotify|disney\+|disney plus|apple\.com\/bill|apple music|amazon prime|prime video|crave\b|youtube premium|hulu|hbo max|icloud|google (one|storage)|xbox game pass|playstation plus|patreon|adobe|dropbox|gym membership|planet fitness|goodlife/i,
    "Subscriptions",
  ],
  [
    /restaurant|tim hortons|starbucks|mcdonald|burger king|wendy'?s|subway|pizza|sushi|a&w|kfc|taco bell|dairy queen|doordash|uber eats|skipthedishes|grubhub|cafe|coffee|bar & grill|pub\b|bistro/i,
    "Dining",
  ],
  [
    /petro-?canada|shell\b|esso|husky|chevron|circle k|couche-tard|gas station|uber\b(?!.*eats)|lyft|taxi|parking|presto|go transit|ttc\b|via rail|car2go|autopay|toll\b/i,
    "Gas & Transport",
  ],
  [
    /air canada|westjet|expedia|airbnb|marriott|hilton|hotel|booking\.com|travelodge|via rail|greyhound/i,
    "Travel",
  ],
  [
    /hydro|electric(ity)?|water bill|gas bill|enbridge|utilities|internet|rogers|bell canada|telus|fido|koodo|virgin plus|freedom mobile|shaw\b|insurance|phone bill|cell(ular)? bill/i,
    "Bills & Utilities",
  ],
  [
    /pharmacy|shoppers drug mart|rexall|walk-?in clinic|dentist|optometrist|physio|massage|medical|clinic\b|hospital/i,
    "Health",
  ],
  [
    /cineplex|movie theatre|concert|ticketmaster|steam\b|nintendo|playstation store|xbox live|bowling|arcade/i,
    "Entertainment",
  ],
  [
    /amazon(?!.*prime)|amzn|best buy|canadian tire|home depot|ikea|winners|marshalls|the bay|indigo\b|apple store|dollarama|shoppers(?! drug)/i,
    "Shopping",
  ],
];

export function guessCategory(description: string): Category {
  for (const [re, cat] of RULES) if (re.test(description)) return cat;
  return "Other";
}
