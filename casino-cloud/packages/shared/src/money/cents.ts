/**
 * Money is handled as integer cents. Floating point amounts never enter money logic.
 * `Cents` is a branded number: it can only be created through the functions below.
 */
export type Cents = number & { readonly __brand: 'Cents' };

/** Largest absolute amount accepted: 100 billion currency units, far inside Number.MAX_SAFE_INTEGER. */
export const MAX_CENTS = 10_000_000_000_000;

export class MoneyError extends Error {}

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`Not an integer cent amount: ${value}`);
  if (Math.abs(value) > MAX_CENTS) throw new MoneyError(`Amount out of range: ${value}`);
  return value as Cents;
}

/**
 * Parses a decimal amount ("12.5", "12.50", 12.5) into cents. More than two decimals,
 * exponents, NaN and infinity are rejected instead of being rounded silently.
 */
export function parseAmount(input: string | number): Cents {
  const text = typeof input === 'number' ? numberToPlainString(input) : input.trim();
  const m = /^(-)?(\d+)(?:[.,](\d{1,2}))?$/.exec(text);
  if (!m) throw new MoneyError(`Invalid amount: ${input}`);
  const [, sign, whole, frac = ''] = m;
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return cents(sign ? -value : value);
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError(`Invalid amount: ${n}`);
  // Shortest round-trip representation, e.g. 0.1 + 0.2 => "0.30000000000000004" (rejected).
  const s = String(n);
  if (/e/i.test(s)) throw new MoneyError(`Invalid amount: ${n}`);
  return s;
}

/** Converts cents to a decimal number for legacy numeric(14,2) columns and display only. */
export function toDecimal(c: Cents): number {
  return c / 100;
}

export function add(...values: Cents[]): Cents {
  return cents(values.reduce((s, v) => s + v, 0));
}

export function subtract(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function negate(a: Cents): Cents {
  return cents(a === 0 ? 0 : -a);
}

export function isPositive(a: Cents): boolean {
  return a > 0;
}

export function formatCents(c: Cents, locale = 'de-AT', currency = 'EUR'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(c / 100);
}
