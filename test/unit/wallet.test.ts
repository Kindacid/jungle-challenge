import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
} from '../../src/shared/domain/domain-error.ts';
import { Money } from '../../src/shared/domain/money.ts';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.ts';
import { Wallet } from '../../src/wallet/domain/wallet.ts';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00.000Z');

function openFunded(amount = '100.00') {
  return Wallet.open({
    id: 'w1',
    playerId: 'p1',
    currency: 'BRL',
    initialBalance: brl(amount),
    openingTransactionId: 'tx-open',
    openingEntryId: 'le-open',
    now,
  });
}

describe('Wallet.open', () => {
  it('is born at version 1 holding the initial balance', () => {
    const { wallet, openingEntry } = openFunded('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  it('opens with zero balance and no opening entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      initialBalance: brl('0.00'),
      now,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  it('requires ids when the initial balance is positive', () => {
    expect(() =>
      Wallet.open({ id: 'w1', playerId: 'p1', currency: 'BRL', initialBalance: brl('1.00'), now }),
    ).toThrow();
  });

  it('rejects a currency mismatch between wallet and initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'w1',
        playerId: 'p1',
        currency: 'USD',
        initialBalance: brl('1.00'),
        openingTransactionId: 't',
        openingEntryId: 'l',
        now,
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet.debit / credit', () => {
  const ctx = (id: string) => ({ transactionId: `tx-${id}`, ledgerEntryId: `le-${id}`, at: now });

  it('debits, bumping version and producing a matching DEBIT entry', () => {
    const { wallet } = openFunded('100.00');
    const entry = wallet.debit(brl('30.00'), ctx('a'));
    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('70.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  it('credits, bumping version and producing a matching CREDIT entry', () => {
    const { wallet } = openFunded('100.00');
    const entry = wallet.credit(brl('25.00'), ctx('b'));
    expect(wallet.balance.toString()).toBe('125.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('rejects a debit that would overdraw and does not mutate state', () => {
    const { wallet } = openFunded('100.00');
    expect(() => wallet.debit(brl('100.01'), ctx('c'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('allows a debit down to exactly zero', () => {
    const { wallet } = openFunded('80.00');
    wallet.debit(brl('80.00'), ctx('d'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('rejects movements in a different currency', () => {
    const { wallet } = openFunded('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, ctx('e'))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, ctx('f'))).toThrow(CurrencyMismatchError);
  });

  it('increments version only on balance changes', () => {
    const { wallet } = openFunded('100.00');
    wallet.debit(brl('10.00'), ctx('g'));
    wallet.credit(brl('5.00'), ctx('h'));
    expect(wallet.version).toBe(3);
  });
});
