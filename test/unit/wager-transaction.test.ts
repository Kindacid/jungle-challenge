import { describe, expect, it } from 'bun:test';
import {
  InvalidInputError,
  InvalidTransactionStateError,
} from '../../src/shared/domain/domain-error.ts';
import { Money } from '../../src/shared/domain/money.ts';
import { FailureCode } from '../../src/wagering/domain/failure-code.ts';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status.ts';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction.ts';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.ts';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const now = new Date('2026-01-01T00:00:00Z');

function make(kind: WagerTransactionKind, ref?: string) {
  return WagerTransaction.create({
    id: 'tx1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId: ref,
    createdAt: now,
  });
}

describe('WagerTransaction.create', () => {
  it('is born PENDING', () => {
    expect(make(WagerTransactionKind.Bet).status).toBe(WagerTransactionStatus.Pending);
  });

  it('rejects OPENING via create()', () => {
    expect(() => make(WagerTransactionKind.Opening)).toThrow(InvalidInputError);
  });

  it('requires a reference for REFUND and ROLLBACK', () => {
    expect(() => make(WagerTransactionKind.Refund)).toThrow(InvalidInputError);
    expect(() => make(WagerTransactionKind.Rollback)).toThrow(InvalidInputError);
    expect(make(WagerTransactionKind.Refund, 'ext-bet').requiresReference()).toBe(true);
  });

  it('rejects a reference on kinds that must not carry one', () => {
    expect(() => make(WagerTransactionKind.Bet, 'ext-x')).toThrow(InvalidInputError);
    expect(() => make(WagerTransactionKind.Loss, 'ext-x')).toThrow(InvalidInputError);
  });

  it('allows WIN to optionally carry a reference (links its BET)', () => {
    expect(() => make(WagerTransactionKind.Win)).not.toThrow(); // reference optional
    const win = make(WagerTransactionKind.Win, 'ext-bet');
    expect(win.referenceExternalTransactionId).toBe('ext-bet');
    expect(win.requiresReference()).toBe(false);
  });
});

describe('WagerTransaction domain queries', () => {
  it('affectsBalance() is false only for LOSS', () => {
    expect(make(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(make(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(make(WagerTransactionKind.Win).affectsBalance()).toBe(true);
  });

  it('computes ledger direction per kind', () => {
    expect(make(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(WagerTransactionKind.Refund, 'ext-bet').ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  it('inverts the reference direction for ROLLBACK', () => {
    const bet = make(WagerTransactionKind.Bet); // debit
    const rollback = make(WagerTransactionKind.Rollback, 'ext-bet');
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const win = make(WagerTransactionKind.Win); // credit
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it('throws when asked for a LOSS direction', () => {
    expect(() => make(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(InvalidInputError);
  });

  it('matchesPayload compares the stored hash', () => {
    const tx = make(WagerTransactionKind.Bet);
    expect(tx.matchesPayload('hash1')).toBe(true);
    expect(tx.matchesPayload('other')).toBe(false);
  });
});

describe('WagerTransaction state machine', () => {
  it('PENDING -> PROCESSED records processedAt and observed balance', () => {
    const tx = make(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, now, brl('75.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(now);
    expect(tx.observedBalance?.toString()).toBe('75.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING -> PENDING_REFERENCE -> PROCESSED', () => {
    const tx = make(WagerTransactionKind.Rollback, 'ext-bet');
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    tx.markProcessed('ref-id', now, brl('100.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  it('PENDING -> REJECTED stores the failure code', () => {
    const tx = make(WagerTransactionKind.Bet);
    tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl('100.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
  });

  it('forbids transitions out of a terminal state', () => {
    const tx = make(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, now, brl('75.00'));
    expect(() => tx.markProcessed(undefined, now, brl('75.00'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl('75.00'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.PROCESSING_RETRIES_EXHAUSTED)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('markPendingReference is only valid from PENDING', () => {
    const tx = make(WagerTransactionKind.Bet);
    tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl('100.00'));
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });
});
