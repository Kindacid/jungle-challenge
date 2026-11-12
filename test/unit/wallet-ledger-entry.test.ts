import { describe, expect, it } from 'bun:test';
import { InvalidInputError } from '../../src/shared/domain/domain-error.ts';
import { Money } from '../../src/shared/domain/money.ts';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.ts';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry.ts';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const base = {
  id: 'le1',
  walletId: 'w1',
  transactionId: 'tx1',
  walletVersion: 2,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('WalletLedgerEntry.create', () => {
  it('accepts a balanced CREDIT entry', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('125.00'),
    });
    expect(e.isBalanced()).toBe(true);
  });

  it('accepts a balanced DEBIT entry', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('70.00'),
    });
    expect(e.isBalanced()).toBe(true);
  });

  it('rejects an unbalanced entry', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('71.00'),
      }),
    ).toThrow(InvalidInputError);
  });

  it('rejects a non-positive amount', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('100.00'),
      }),
    ).toThrow(InvalidInputError);
  });

  it('rejects a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('30.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: Money.from({ amount: '20.00', currency: 'BRL' }).negate(),
      }),
    ).toThrow(InvalidInputError);
  });

  it('has no mutable fields (structural immutability)', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('125.00'),
    });
    // Every own enumerable property is read-only by construction; there are no
    // setters/transition methods on the entry.
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(e));
    expect(methodNames.filter((m) => m.startsWith('mark') || m.startsWith('set'))).toHaveLength(0);
  });
});
