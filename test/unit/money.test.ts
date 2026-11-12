import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidInputError } from '../../src/shared/domain/domain-error.ts';
import { Money } from '../../src/shared/domain/money.ts';

describe('Money.from', () => {
  it('accepts a canonical 2-decimal string', () => {
    const m = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(m.toString()).toBe('25.00');
    expect(m.currency).toBe('BRL');
    expect(m.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('rejects — never rounds — amounts with more than 2 decimals', () => {
    expect(() => Money.from({ amount: '1.234', currency: 'BRL' })).toThrow(InvalidInputError);
    expect(() => Money.from({ amount: '1.999', currency: 'BRL' })).toThrow(InvalidInputError);
  });

  it('rejects amounts with fewer than 2 decimals', () => {
    expect(() => Money.from({ amount: '1', currency: 'BRL' })).toThrow(InvalidInputError);
    expect(() => Money.from({ amount: '1.0', currency: 'BRL' })).toThrow(InvalidInputError);
  });

  it('rejects NaN, Infinity, scientific notation and empty string', () => {
    for (const amount of ['NaN', 'Infinity', '-Infinity', '1e3', '1E3', '', ' ', 'abc']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidInputError);
    }
  });

  it('rejects negative amounts on the input contract', () => {
    expect(() => Money.from({ amount: '-5.00', currency: 'BRL' })).toThrow(InvalidInputError);
  });

  it('rejects leading-zero integer parts', () => {
    expect(() => Money.from({ amount: '05.00', currency: 'BRL' })).toThrow(InvalidInputError);
    expect(() => Money.from({ amount: '00.00', currency: 'BRL' })).toThrow(InvalidInputError);
  });

  it('accepts a single zero integer part', () => {
    expect(Money.from({ amount: '0.00', currency: 'BRL' }).isZero()).toBe(true);
  });

  it('rejects invalid currency codes', () => {
    for (const currency of ['br', 'BRLL', '123', '', 'brl']) {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidInputError);
    }
  });
});

describe('Money arithmetic', () => {
  const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

  it('adds and subtracts exactly, keeping scale 2', () => {
    expect(brl('25.00').add(brl('0.10')).toString()).toBe('25.10');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  it('does not accumulate binary floating point error', () => {
    // 0.10 + 0.20 would be 0.30000000000000004 with doubles.
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  it('negate() flips the sign and is reversible', () => {
    expect(brl('5.00').negate().toString()).toBe('-5.00');
    expect(brl('5.00').negate().negate().toString()).toBe('5.00');
  });

  it('is immutable — operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('11.00');
    expect(a).not.toBe(b);
  });

  it('compares values correctly', () => {
    expect(brl('10.00').isLessThan(brl('10.01'))).toBe(true);
    expect(brl('10.01').isGreaterThan(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(brl('10.00'))).toBe(true);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('5.00').negate().isNegative()).toBe(true);
  });

  it('throws on cross-currency arithmetic and comparison', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('equals() is false across currencies even for the same amount', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});

describe('Money.zero', () => {
  it('produces a scale-2 zero', () => {
    expect(Money.zero('BRL').toString()).toBe('0.00');
  });
});
