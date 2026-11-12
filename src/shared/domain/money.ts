import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidInputError } from './domain-error.ts';

// Configure Decimal globally for monetary math: high precision, no surprise
// rounding. We never *round* money on input — we reject anything that is not
// already at the fixed scale. ROUND_HALF_EVEN is only a safety net for internal
// arithmetic that is already guaranteed to stay at scale 2 (add/sub/negate).
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/** Fixed scale for every supported currency in this challenge (minor units). */
export const MONEY_SCALE = 2;

/** DTO shape used across contracts (HTTP bodies, event payloads, persistence). */
export interface MoneyProps {
  /** Decimal string with exactly 2 fraction digits, e.g. "25.00". Never negative. */
  amount: string;
  /** ISO-4217 code, e.g. "BRL". */
  currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
// Input contract: a NON-NEGATIVE amount, integer part with no leading zeros, and
// EXACTLY two fraction digits. Rejects "", "1", "1.0", "1.000", "1e3", "NaN",
// "Infinity", "-5.00". Internal negatives (from negate()/subtract()) never go
// through here — they are produced via the private constructor and only ever
// rendered by toString(), which handles the sign.
const AMOUNT_RE = /^(0|[1-9]\d*)\.\d{2}$/;

/**
 * Immutable money value object. Holds an exact `Decimal` internally and a
 * currency; every operation returns a new instance. It depends on no ORM type
 * and no framework decorator — the domain owns it entirely.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Build money from a contract DTO. The amount MUST already be a canonical
   * 2-decimal string; values with more precision are rejected, never rounded.
   */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
      throw new InvalidInputError(`invalid currency: ${JSON.stringify(currency)}`);
    }
    if (typeof amount !== 'string' || !AMOUNT_RE.test(amount)) {
      throw new InvalidInputError(`invalid money amount: ${JSON.stringify(amount)}`);
    }

    // Regex already guarantees a finite, scale-2 decimal; this cannot throw.
    const value = new Decimal(amount);
    return new Money(value, currency);
  }

  /** Zero at the fixed scale for the given currency. */
  static zero(currency: string): Money {
    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
      throw new InvalidInputError(`invalid currency: ${JSON.stringify(currency)}`);
    }
    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  /** Absolute value — useful when deriving a reversal amount from a signed delta. */
  abs(): Money {
    return new Money(this.value.abs(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** Serialize to the canonical DTO (always exactly 2 fraction digits). */
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Canonical decimal string, fixed to the money scale (e.g. "25.00", "-5.00"). */
  toString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
