// =============================================================================
// money.js — canonical money helpers (MP-116)
//
// Why this module exists
// ----------------------
// Floating-point money is a classic source of bugs: 0.1 + 0.2 !== 0.3, and
// once you've multiplied a few times the rounding errors leak into totals.
// To prevent that, EVERY amount in the payment system is stored and passed
// around as an integer number of cents. This module is the only place the
// codebase converts between cents and human-readable dollars.
//
// Convention used everywhere downstream:
//   - "cents"  = an integer (e.g. 24050 = $240.50). Always non-negative for
//                amounts we own (subtotal, total, etc.); credit-note rows
//                may legitimately be negative.
//   - "display" / "dollars" = a number or numeric string entered by a human
//                in the UI (e.g. 240.5, "240.50"). NEVER passed to Firestore.
//
// Usage
// -----
//   import { toCents, fromCents, formatMoney, addAmounts, multiplyAmount }
//     from "./money.js";
//
//   const rateCents = toCents("85.50");          // 8550
//   const totalCents = multiplyAmount(rateCents, 1.5); // 12825
//   formatMoney(totalCents);                     // "$128.25" (en)
//   formatMoney(totalCents, "fr");               // "128,25 $"
//
// Banker's rounding
// -----------------
// `multiplyAmount` uses half-to-even rounding (a.k.a. banker's rounding) for
// tax math: when the decimal portion is exactly .5, it rounds toward the
// even neighbour. Over many transactions this avoids the systematic upward
// bias of half-away-from-zero. It matches what GST/QST regulators and most
// accounting systems expect.
// =============================================================================

/**
 * Convert a human-entered dollar amount to integer cents.
 *
 * Accepts either a number (24.5) or a numeric string ("24.50", "24,50").
 * Strings may use a comma as the decimal separator (FR) and may include a
 * leading "$" — both are stripped. Empty / null / non-numeric inputs return 0.
 *
 * @param {number|string} input
 * @returns {number} integer cents (>= 0 for typical inputs; preserves sign)
 *
 * @example
 *   toCents(24.50)   // 2450
 *   toCents("24,50") // 2450
 *   toCents("$1,234.56") // 123456
 *   toCents("")      // 0
 */
export function toCents(input) {
  if (input === null || input === undefined || input === "") return 0;
  let n;
  if (typeof input === "number") {
    n = input;
  } else if (typeof input === "string") {
    // Strip currency symbol, thousands separators (spaces and apostrophes
    // appear in some locales), then normalize comma -> dot for the decimal.
    // Note: we intentionally don't try to be clever about distinguishing
    // thousands-comma from decimal-comma — the form fields that feed this
    // function are single-amount inputs, not "1,234.56" formatted strings.
    const cleaned = input
      .replace(/\s/g, "")
      .replace(/[$\u00A0]/g, "")
      .replace(/'/g, "")
      .replace(",", ".");
    n = Number(cleaned);
  } else {
    return 0;
  }
  if (!Number.isFinite(n)) return 0;
  // Multiply by 100 then round to nearest int with half-AWAY-from-zero
  // (i.e. symmetric: 0.5 → 1, -0.5 → -1). We can't just use Math.round
  // here because Math.round in JavaScript rounds halves toward +∞, so
  // Math.round(-0.5) returns -0 instead of -1 — that asymmetry would
  // leak into refund/credit-note math. The banker's rounding for tax
  // calculations lives in multiplyAmount where the bias actually matters.
  const scaled = n * 100;
  return scaled >= 0
    ? Math.floor(scaled + 0.5)
    : -Math.floor(-scaled + 0.5);
}

/**
 * Convert integer cents back to a plain JS number of dollars.
 *
 * Use this only when you need a numeric value (e.g. to feed into a chart
 * library). For display, prefer formatMoney() — it handles locale.
 *
 * @param {number} cents integer cents
 * @returns {number} dollars (e.g. 24.5 for 2450 cents)
 */
export function fromCents(cents) {
  if (!Number.isFinite(cents)) return 0;
  return cents / 100;
}

/**
 * Format integer cents as a localized currency string.
 *
 * - "en" → "$240.50" (USD-style sign-then-amount).
 * - "fr" → "240,50 $" (Quebec French: amount-then-sign with a space).
 *
 * Negative amounts render with a leading "-" before the symbol in both
 * locales (e.g. "-$80.00", "-80,00 $"). Uses Intl.NumberFormat under the
 * hood for the digit grouping, then post-processes for the FR placement
 * because Intl's "fr-CA" output ("240,50 $ CA") includes the country code
 * we don't want.
 *
 * @param {number} cents integer cents
 * @param {"en"|"fr"} [locale="en"]
 * @returns {string}
 */
export function formatMoney(cents, locale = "en") {
  const safe = Number.isFinite(cents) ? cents : 0;
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const dollars = abs / 100;

  if (locale === "fr") {
    // FR: "1 234,56 $" — non-breaking space as thousands separator, comma
    // as decimal, "$" suffix preceded by a regular space. We build it
    // manually to keep the output stable across Node/browser Intl impls.
    const fixed = dollars.toFixed(2);
    const [intPart, decPart] = fixed.split(".");
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0");
    return `${negative ? "-" : ""}${grouped},${decPart}\u00A0$`;
  }

  // EN: "$1,234.56"
  const formatted = dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${negative ? "-" : ""}$${formatted}`;
}

/**
 * Sum any number of cent amounts. Non-finite inputs are treated as 0.
 *
 * Exists so callers don't reach for `a + b + c` and accidentally trip a
 * lint rule we may add later that bans bare arithmetic on money fields.
 *
 * @param  {...number} amounts integer cents
 * @returns {number} integer cents
 */
export function addAmounts(...amounts) {
  let sum = 0;
  for (const a of amounts) {
    if (Number.isFinite(a)) sum += a;
  }
  // All inputs are integers, so the sum is too — no rounding needed.
  return sum;
}

/**
 * Multiply a cents amount by a (typically fractional) factor and round to
 * the nearest integer cent using banker's rounding (half-to-even).
 *
 * Use this for: applying a percentage (tax, discount), splitting a price
 * across attendees, multiplying a per-hour rate by a duration in hours.
 *
 * Why banker's rounding: when computing 5% GST on $0.05, the exact answer
 * is 0.25 cents. Half-away-from-zero would always round that to 1 cent;
 * over thousands of line items that's a noticeable upward drift in the
 * total tax collected. Banker's rounding alternates between rounding
 * toward 0 and toward ±1, eliminating the bias on average. (CRA's docs
 * for GST/QST tolerate either method as long as it's consistent — but
 * banker's is what most accounting systems use.)
 *
 * @param {number} cents integer cents
 * @param {number} factor multiplier (e.g. 0.05 for 5% tax, 1.5 for 1.5h)
 * @returns {number} integer cents
 */
export function multiplyAmount(cents, factor) {
  if (!Number.isFinite(cents) || !Number.isFinite(factor)) return 0;
  const product = cents * factor;
  return roundHalfToEven(product);
}

/**
 * Compute add-on tax lines for a net subtotal.
 *
 * @param {number} subtotalCents integer cents before tax
 * @param {object} settings tax settings
 * @param {boolean} settings.taxEnabled whether tax should be applied
 * @param {number} settings.gstRate GST rate as a decimal (0.05 = 5%)
 * @param {number} settings.qstRate QST rate as a decimal (0.09975 = 9.975%)
 * @returns {{ gstCents: number, qstCents: number, totalCents: number }}
 */
export function calculateTaxTotals(subtotalCents, settings = {}) {
  const safeSubtotal = Number.isFinite(subtotalCents) ? subtotalCents : 0;
  const taxEnabled = !!settings.taxEnabled;
  const gstRate = Number(settings.gstRate) || 0;
  const qstRate = Number(settings.qstRate) || 0;
  const gstCents = taxEnabled ? multiplyAmount(safeSubtotal, gstRate) : 0;
  const qstCents = taxEnabled ? multiplyAmount(safeSubtotal, qstRate) : 0;
  return {
    gstCents,
    qstCents,
    totalCents: safeSubtotal + gstCents + qstCents,
  };
}

/**
 * Extract included tax amounts from a gross total where tax is already baked
 * into the price shown to the payer.
 *
 * @param {number} grossCents integer cents including tax
 * @param {number} gstRate GST rate as a decimal
 * @param {number} qstRate QST rate as a decimal
 * @returns {{ gstCents: number, qstCents: number }}
 */
export function includedTaxAmounts(grossCents, gstRate, qstRate) {
  const safeGross = Number.isFinite(grossCents) ? grossCents : 0;
  const safeGstRate = Number(gstRate) || 0;
  const safeQstRate = Number(qstRate) || 0;
  const totalRate = 1 + safeGstRate + safeQstRate;
  if (!Number.isFinite(totalRate) || totalRate <= 0) {
    return { gstCents: 0, qstCents: 0 };
  }
  return {
    gstCents: multiplyAmount(safeGross, safeGstRate / totalRate),
    qstCents: multiplyAmount(safeGross, safeQstRate / totalRate),
  };
}

/**
 * Compute overdue interest against the unpaid base invoice amount.
 *
 * Credits are applied after interest in the invoice UI, so this helper only
 * subtracts amounts actually paid against the base total.
 *
 * @param {object} invoice invoice-like object
 * @param {boolean} isOverdue caller's status decision
 * @returns {number} interest in integer cents
 */
export function calculateOverdueInterest(invoice, isOverdue) {
  if (!isOverdue) return 0;
  const bps = Math.max(0, Number(invoice?.overdueInterestBps) || 0);
  if (!bps) return 0;
  const total = Number(invoice?.total) || 0;
  const paidTowardBase = Math.min(Math.max(0, Number(invoice?.paidAmount) || 0), total);
  const unpaidBase = Math.max(0, total - paidTowardBase);
  return multiplyAmount(unpaidBase, bps / 10000);
}

/**
 * Final invoice amount still due after overdue interest and applied credit.
 *
 * @param {object} invoice invoice-like object
 * @param {number} overdueInterestCents integer cents
 * @returns {number} amount due in integer cents
 */
export function invoiceAmountDue(invoice, overdueInterestCents = 0) {
  const total = Number(invoice?.total) || 0;
  const paid = Math.max(0, Number(invoice?.paidAmount) || 0);
  const credit = Math.max(0, Number(invoice?.creditApplied) || 0);
  return Math.max(0, total + overdueInterestCents - paid - credit);
}

/**
 * Round to the nearest integer, breaking ties (.5) toward the even neighbour.
 *
 * Examples (positive):
 *   2.5 → 2     (down to even)
 *   3.5 → 4     (up to even)
 *   2.4 → 2     (normal nearest)
 *   2.6 → 3     (normal nearest)
 *
 * Negative values are handled by symmetry: -2.5 → -2, -3.5 → -4.
 *
 * Implementation note: we explicitly check for the .5 case using a small
 * epsilon, because IEEE-754 double precision means `cents * 0.05` for
 * many inputs lands at e.g. 12.499999999999998 instead of 12.5. The
 * epsilon catches those near-misses without being so loose that it
 * corrupts inputs that genuinely aren't ties. 1e-9 is well below any
 * meaningful sub-cent precision.
 *
 * @param {number} value
 * @returns {number} integer
 */
function roundHalfToEven(value) {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const floor = Math.floor(abs);
  const diff = abs - floor;
  const EPS = 1e-9;

  let rounded;
  if (diff < 0.5 - EPS) {
    rounded = floor;
  } else if (diff > 0.5 + EPS) {
    rounded = floor + 1;
  } else {
    // Exactly (within tolerance) a .5 tie: pick the even neighbour.
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return sign * rounded;
}
