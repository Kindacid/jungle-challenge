import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Money } from '../../src/shared/domain/money.ts';
import { FailureCode } from '../../src/wagering/domain/failure-code.ts';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status.ts';
import { Wallet } from '../../src/wallet/domain/wallet.ts';
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

function cmd(
  walletId: string,
  playerId: string,
  ext: string,
  kind: WagerTransactionKind,
  amount: string,
  ref?: string,
) {
  return {
    idempotencyKey: `p:${ext}`,
    providerId: 'p',
    externalTransactionId: ext,
    playerId,
    walletId,
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: ref,
    correlationId: uuid(),
  };
}

describe('out-of-order references (resolver)', () => {
  it('parks a ROLLBACK that arrives before its BET, then resolves it once the BET lands', async () => {
    const { walletId, playerId } = await openWallet('100.00');

    // ROLLBACK arrives first -> PENDING_REFERENCE, no balance change.
    const pending = await c.submit.execute(
      cmd(walletId, playerId, 'rb1', WagerTransactionKind.Rollback, '40.00', 'bet1'),
    );
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect((await c.wallets.findById(db.orm.em.fork(), walletId))?.balance.toString()).toBe(
      '100.00',
    );

    // The BET lands -> PROCESSED (and nudges the parked rollback).
    const bet = await c.submit.execute(
      cmd(walletId, playerId, 'bet1', WagerTransactionKind.Bet, '40.00'),
    );
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.balance.toString()).toBe('60.00');

    // Resolver runs -> rollback reverses the bet (credit), balance back to 100.
    const handled = await c.resolver.processDueBatch();
    expect(handled).toBeGreaterThanOrEqual(1);

    const rb = await c.transactions.findByProviderExternalId(db.orm.em.fork(), 'p', 'rb1');
    expect(rb?.status).toBe(WagerTransactionStatus.Processed);
    expect((await c.wallets.findById(db.orm.em.fork(), walletId))?.balance.toString()).toBe(
      '100.00',
    );
    await assertLedgerInvariant(db.orm, walletId);
  });

  it('rejects with REFERENCE_NOT_FOUND once the retry budget is exhausted', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    await c.submit.execute(
      cmd(walletId, playerId, 'rb2', WagerTransactionKind.Refund, '10.00', 'ghost'),
    );

    // Fast-forward: set attempts to the last one and make it due now.
    const max = c.config.worker.pendingReferenceMaxAttempts;
    await db.orm.em
      .getConnection()
      .execute(
        `UPDATE wager_transactions SET reference_attempts = ${max - 1}, next_reference_attempt_at = now() - interval '1 second' WHERE external_transaction_id = 'rb2'`,
      );

    await c.resolver.processDueBatch();

    const rb = await c.transactions.findByProviderExternalId(db.orm.em.fork(), 'p', 'rb2');
    expect(rb?.status).toBe(WagerTransactionStatus.Rejected);
    expect(rb?.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
  });
});

describe('transactional atomicity', () => {
  it('rolls the whole unit of work back when it throws before commit', async () => {
    const orphanId = uuid();
    const playerId = uuid();
    await expect(
      c.txRunner.run(async (em) => {
        const { wallet } = Wallet.open({
          id: orphanId,
          playerId,
          currency: 'BRL',
          initialBalance: brl('0.00'),
          now: new Date(),
        });
        await c.wallets.insert(em, wallet);
        throw new Error('boom before commit');
      }),
    ).rejects.toThrow('boom');

    // Nothing persisted.
    const found = await c.wallets.findById(db.orm.em.fork(), orphanId);
    expect(found).toBeNull();
  });
});

describe('inbox redelivery (crash-after-commit guarantee)', () => {
  it('does not duplicate the effect when the same message is delivered twice', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const message = {
      ...cmd(walletId, playerId, 'sqs-dup', WagerTransactionKind.Bet, '30.00'),
      inbox: { consumerName: 'wager-transactions-consumer', messageId: 'inbox-m1' },
    };

    const first = await c.submit.execute(message);
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.idempotentReplay).toBe(false);

    const second = await c.submit.execute(message); // redelivery
    expect(second.idempotentReplay).toBe(true);

    expect(await countLedgerEntries(db.orm, walletId, 'DEBIT')).toBe(1);
    expect((await c.wallets.findById(db.orm.em.fork(), walletId))?.balance.toString()).toBe(
      '70.00',
    );
    await assertLedgerInvariant(db.orm, walletId);
  });
});

describe('outbox concurrent publishers', () => {
  it('claims each pending event exactly once across two publishers (SKIP LOCKED)', async () => {
    const now = new Date();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = uuid();
      ids.push(id);
      await db.orm.em.getConnection().execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, attempts, next_attempt_at)
           VALUES (?, 'agg', 'TestEvent', 1, CAST('{}' AS jsonb), ?, 0, ?)`,
        [id, now, now],
      );
    }

    const [batchA, batchB] = await Promise.all([
      c.txRunner.run((em) => c.outbox.claimBatch(em, 'pub-A', 30, 50, now)),
      c.txRunner.run((em) => c.outbox.claimBatch(em, 'pub-B', 30, 50, now)),
    ]);

    const claimedA = batchA.map((m) => m.id);
    const claimedB = batchB.map((m) => m.id);
    const overlap = claimedA.filter((id) => claimedB.includes(id));
    expect(overlap).toHaveLength(0); // no row claimed twice

    const union = new Set([...claimedA, ...claimedB]);
    for (const id of ids) expect(union.has(id)).toBe(true); // all claimed
  });
});
