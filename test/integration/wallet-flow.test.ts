import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { IdempotencyConflictError } from '../../src/shared/application/application-errors.ts';
import { Money } from '../../src/shared/domain/money.ts';
import { FailureCode } from '../../src/wagering/domain/failure-code.ts';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status.ts';
import { type TestContainer, buildContainer, uuid } from '../support/container.ts';
import { type TestDatabase, createTestDatabase } from '../support/database.ts';
import { assertLedgerInvariant, countLedgerEntries } from '../support/invariants.ts';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

let db: TestDatabase;
let c: TestContainer;

beforeAll(async () => {
  db = await createTestDatabase();
  c = buildContainer(db.orm);
});

afterAll(async () => {
  await db?.teardown();
});

async function openWallet(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuid();
  const res = await c.createWallet.execute({
    playerId,
    initialBalance: brl(amount),
    correlationId: uuid(),
  });
  return { walletId: res.id, playerId };
}

function bet(walletId: string, playerId: string, ext: string, amount: string) {
  return {
    idempotencyKey: `provider-a:${ext}`,
    providerId: 'provider-a',
    externalTransactionId: ext,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl(amount),
    correlationId: uuid(),
  };
}

describe('wallet creation + OPENING', () => {
  it('opens a funded wallet at version 1 with a backing opening entry', async () => {
    const { walletId } = await openWallet('1000.00');
    const wallet = await c.wallets.findById(db.orm.em.fork(), walletId);
    expect(wallet?.balance.toString()).toBe('1000.00');
    expect(wallet?.version).toBe(1);
    await assertLedgerInvariant(db.orm, walletId);
    expect(await countLedgerEntries(db.orm, walletId, 'CREDIT')).toBe(1);
  });

  it('rejects a duplicate wallet for the same player+currency', async () => {
    const playerId = uuid();
    await c.createWallet.execute({ playerId, initialBalance: brl('10.00'), correlationId: uuid() });
    await expect(
      c.createWallet.execute({ playerId, initialBalance: brl('10.00'), correlationId: uuid() }),
    ).rejects.toThrow();
  });
});

describe('BET processing and idempotency', () => {
  it('debits on a BET and keeps the ledger invariant', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const res = await c.submit.execute(bet(walletId, playerId, 'tx-1', '25.00'));
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balance.toString()).toBe('75.00');
    expect(res.idempotentReplay).toBe(false);
    await assertLedgerInvariant(db.orm, walletId);
    expect(await countLedgerEntries(db.orm, walletId, 'DEBIT')).toBe(1);
  });

  it('replays an identical request without a second debit', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    await c.submit.execute(bet(walletId, playerId, 'tx-r', '25.00'));
    const replay = await c.submit.execute(bet(walletId, playerId, 'tx-r', '25.00'));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.toString()).toBe('75.00');
    expect(await countLedgerEntries(db.orm, walletId, 'DEBIT')).toBe(1);
    await assertLedgerInvariant(db.orm, walletId);
  });

  it('treats the same key with a different payload as a conflict', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    await c.submit.execute(bet(walletId, playerId, 'tx-c', '25.00'));
    await expect(c.submit.execute(bet(walletId, playerId, 'tx-c', '26.00'))).rejects.toThrow(
      IdempotencyConflictError,
    );
  });

  it('rejects a BET without funds and writes no ledger entry', async () => {
    const { walletId, playerId } = await openWallet('10.00');
    const res = await c.submit.execute(bet(walletId, playerId, 'tx-nf', '25.00'));
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(res.balance.toString()).toBe('10.00');
    expect(await countLedgerEntries(db.orm, walletId, 'DEBIT')).toBe(0);
    await assertLedgerInvariant(db.orm, walletId);
  });
});

describe('REFUND single-use reversal', () => {
  it('refunds a processed BET once, then rejects a second reversal', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    await c.submit.execute(bet(walletId, playerId, 'bet-x', '40.00'));

    const refund = {
      idempotencyKey: 'provider-a:refund-x',
      providerId: 'provider-a',
      externalTransactionId: 'refund-x',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: brl('40.00'),
      referenceExternalTransactionId: 'bet-x',
      correlationId: uuid(),
    };
    const res = await c.submit.execute(refund);
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balance.toString()).toBe('100.00');

    const second = await c.submit.execute({
      ...refund,
      idempotencyKey: 'provider-a:refund-x2',
      externalTransactionId: 'refund-x2',
    });
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.ALREADY_REVERSED);
    await assertLedgerInvariant(db.orm, walletId);
  });
});

describe('schema enforces the invariants (raw SQL is rejected)', () => {
  it('forbids a negative wallet balance', async () => {
    const { walletId } = await openWallet('10.00');
    await expect(
      db.orm.em
        .getConnection()
        .execute(`UPDATE wallets SET balance_amount = -1 WHERE id = '${walletId}'`),
    ).rejects.toThrow();
  });

  it('forbids updating or deleting ledger entries (append-only)', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    await c.submit.execute(bet(walletId, playerId, 'tx-ap', '10.00'));
    await expect(
      db.orm.em
        .getConnection()
        .execute(
          `UPDATE wallet_ledger_entries SET amount = amount + 1 WHERE wallet_id = '${walletId}'`,
        ),
    ).rejects.toThrow();
    await expect(
      db.orm.em
        .getConnection()
        .execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = '${walletId}'`),
    ).rejects.toThrow();
  });
});
