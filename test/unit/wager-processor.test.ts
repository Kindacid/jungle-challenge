import { describe, expect, it } from 'bun:test';
import { Money, type MoneyProps } from '../../src/shared/domain/money.ts';
import { FailureCode } from '../../src/wagering/domain/failure-code.ts';
import { WagerProcessor } from '../../src/wagering/domain/wager-processor.ts';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status.ts';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction.ts';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.ts';
import { Wallet } from '../../src/wallet/domain/wallet.ts';

const now = new Date('2026-01-01T00:00:00Z');
const processor = new WagerProcessor();

function wallet(amount = '100.00', currency = 'BRL', playerId = 'p1') {
  return Wallet.open({
    id: 'w1',
    playerId,
    currency,
    initialBalance: Money.from({ amount, currency }),
    openingTransactionId: 't0',
    openingEntryId: 'l0',
    now,
  }).wallet;
}

interface TxOverrides {
  id?: string;
  kind: WagerTransactionKind;
  money?: MoneyProps;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  providerId?: string;
  ref?: string;
  status?: WagerTransactionStatus;
}

function tx(o: TxOverrides): WagerTransaction {
  const t = WagerTransaction.create({
    id: o.id ?? 'tx1',
    providerId: o.providerId ?? 'provider-a',
    externalTransactionId: o.id ?? 'ext-1',
    idempotencyKey: `k-${o.id ?? 'tx1'}`,
    payloadHash: 'h',
    walletId: o.walletId ?? 'w1',
    playerId: o.playerId ?? 'p1',
    roundId: o.roundId ?? 'r1',
    gameId: 'g1',
    kind: o.kind,
    money: Money.from(o.money ?? { amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: o.ref,
    createdAt: now,
  });
  if (o.status === WagerTransactionStatus.Processed) {
    t.markProcessed(undefined, now, Money.from(o.money ?? { amount: '25.00', currency: 'BRL' }));
  }
  return t;
}

const decide = (
  w: Wallet,
  transaction: WagerTransaction,
  reference: WagerTransaction | null = null,
  opts: { referenceAlreadyReversed?: boolean; referenceLookupExhausted?: boolean } = {},
) =>
  processor.decide({
    wallet: w,
    transaction,
    reference,
    referenceAlreadyReversed: opts.referenceAlreadyReversed ?? false,
    referenceLookupExhausted: opts.referenceLookupExhausted,
  });

describe('BET', () => {
  it('is processed as a DEBIT when funds suffice', () => {
    const d = decide(wallet('100.00'), tx({ kind: WagerTransactionKind.Bet }));
    expect(d).toEqual({ type: 'processed', direction: LedgerDirection.Debit });
  });

  it('is rejected with INSUFFICIENT_FUNDS when it would overdraw', () => {
    const d = decide(wallet('10.00'), tx({ kind: WagerTransactionKind.Bet }));
    expect(d).toEqual({ type: 'rejected', code: FailureCode.INSUFFICIENT_FUNDS });
  });
});

describe('WIN / LOSS', () => {
  it('WIN is a CREDIT', () => {
    const d = decide(wallet('0.00'), tx({ kind: WagerTransactionKind.Win }));
    expect(d).toEqual({ type: 'processed', direction: LedgerDirection.Credit });
  });

  it('LOSS is processed with no direction (no ledger movement)', () => {
    const d = decide(wallet('100.00'), tx({ kind: WagerTransactionKind.Loss }));
    expect(d).toEqual({ type: 'processed', direction: null });
  });
});

describe('identity checks', () => {
  it('rejects a currency mismatch', () => {
    const d = decide(
      wallet('100.00', 'BRL'),
      tx({ kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'USD' } }),
    );
    expect(d).toEqual({ type: 'rejected', code: FailureCode.CURRENCY_MISMATCH });
  });

  it('rejects a wallet/player mismatch', () => {
    const d = decide(
      wallet('100.00', 'BRL', 'p1'),
      tx({ kind: WagerTransactionKind.Bet, playerId: 'p2' }),
    );
    expect(d).toEqual({ type: 'rejected', code: FailureCode.WALLET_PLAYER_MISMATCH });
  });
});

describe('REFUND', () => {
  const bet = (status = WagerTransactionStatus.Processed) =>
    tx({ id: 'bet', kind: WagerTransactionKind.Bet, status });

  it('credits when it reverses a processed BET of equal amount, once', () => {
    const d = decide(
      wallet('0.00'),
      tx({ id: 'ref', kind: WagerTransactionKind.Refund, ref: 'bet' }),
      bet(),
    );
    expect(d).toEqual({
      type: 'processed',
      direction: LedgerDirection.Credit,
      referenceTransactionId: 'bet',
    });
  });

  it('waits (PENDING_REFERENCE) when the reference is missing', () => {
    const d = decide(wallet(), tx({ id: 'ref', kind: WagerTransactionKind.Refund, ref: 'bet' }));
    expect(d).toEqual({ type: 'pending_reference' });
  });

  it('becomes REFERENCE_NOT_FOUND when the lookup is exhausted', () => {
    const d = decide(
      wallet(),
      tx({ id: 'ref', kind: WagerTransactionKind.Refund, ref: 'bet' }),
      null,
      { referenceLookupExhausted: true },
    );
    expect(d).toEqual({ type: 'rejected', code: FailureCode.REFERENCE_NOT_FOUND });
  });

  it('rejects when the reference is not processed', () => {
    const d = decide(
      wallet(),
      tx({ id: 'ref', kind: WagerTransactionKind.Refund, ref: 'bet' }),
      bet(WagerTransactionStatus.Pending),
    );
    expect(d).toEqual({ type: 'rejected', code: FailureCode.REFERENCE_NOT_PROCESSED });
  });

  it('rejects when the reference is not a BET', () => {
    const win = tx({
      id: 'win',
      kind: WagerTransactionKind.Win,
      status: WagerTransactionStatus.Processed,
    });
    const d = decide(
      wallet(),
      tx({ id: 'ref', kind: WagerTransactionKind.Refund, ref: 'win' }),
      win,
    );
    expect(d).toEqual({ type: 'rejected', code: FailureCode.REFERENCE_KIND_NOT_ALLOWED });
  });

  it('rejects on amount mismatch', () => {
    const d = decide(
      wallet(),
      tx({
        id: 'ref',
        kind: WagerTransactionKind.Refund,
        ref: 'bet',
        money: { amount: '30.00', currency: 'BRL' },
      }),
      bet(),
    );
    expect(d).toEqual({ type: 'rejected', code: FailureCode.REFERENCE_AMOUNT_MISMATCH });
  });

  it('rejects a reference from a different round', () => {
    const otherBet = tx({
      id: 'bet',
      kind: WagerTransactionKind.Bet,
      roundId: 'r2',
      status: WagerTransactionStatus.Processed,
    });
    const d = decide(
      wallet(),
      tx({ id: 'ref', kind: WagerTransactionKind.Refund, ref: 'bet', roundId: 'r1' }),
      otherBet,
    );
    expect(d).toEqual({ type: 'rejected', code: FailureCode.REFERENCE_MISMATCH });
  });

  it('rejects a second reversal of the same reference', () => {
    const d = decide(
      wallet(),
      tx({ id: 'ref', kind: WagerTransactionKind.Refund, ref: 'bet' }),
      bet(),
      { referenceAlreadyReversed: true },
    );
    expect(d).toEqual({ type: 'rejected', code: FailureCode.ALREADY_REVERSED });
  });
});

describe('ROLLBACK', () => {
  it('credits back a BET (inverse of a debit)', () => {
    const bet = tx({
      id: 'bet',
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Processed,
    });
    const d = decide(
      wallet('0.00'),
      tx({ id: 'rb', kind: WagerTransactionKind.Rollback, ref: 'bet' }),
      bet,
    );
    expect(d).toEqual({
      type: 'processed',
      direction: LedgerDirection.Credit,
      referenceTransactionId: 'bet',
    });
  });

  it('debits back a WIN, and rejects when that would overdraw', () => {
    const win = tx({
      id: 'win',
      kind: WagerTransactionKind.Win,
      status: WagerTransactionStatus.Processed,
    });
    const rb = tx({ id: 'rb', kind: WagerTransactionKind.Rollback, ref: 'win' });

    // Enough balance -> debit.
    expect(decide(wallet('100.00'), rb, win)).toEqual({
      type: 'processed',
      direction: LedgerDirection.Debit,
      referenceTransactionId: 'win',
    });

    // Funds already withdrawn -> distinct reversal failure code.
    expect(decide(wallet('0.00'), rb, win)).toEqual({
      type: 'rejected',
      code: FailureCode.REVERSAL_INSUFFICIENT_FUNDS,
    });
  });
});
