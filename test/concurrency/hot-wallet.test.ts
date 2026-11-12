import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Money } from '../../src/shared/domain/money.ts';
import { FailureCode } from '../../src/wagering/domain/failure-code.ts';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status.ts';
import { type TestContainer, buildContainer, uuid } from '../support/container.ts';
import { type TestDatabase, createTestDatabase } from '../support/database.ts';
import { assertLedgerInvariant, countLedgerEntries } from '../support/invariants.ts';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const TIMEOUT = 30_000;

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

describe('hot wallet concurrency', () => {
  it(
    'processes the SAME bet sent 50x in parallel as a single debit',
    async () => {
      const { walletId, playerId } = await openWallet('100.00');
      const command = bet(walletId, playerId, 'dup-bet', '25.00');

      const results = await Promise.all(
        Array.from({ length: 50 }, () => c.submit.execute({ ...command })),
      );

      const fresh = results.filter((r) => !r.idempotentReplay);
      const replays = results.filter((r) => r.idempotentReplay);
      expect(fresh).toHaveLength(1);
      expect(replays).toHaveLength(49);
      for (const r of results) {
        expect(r.status).toBe(WagerTransactionStatus.Processed);
        expect(r.balance.toString()).toBe('75.00');
      }
      expect(await countLedgerEntries(db.orm, walletId, 'DEBIT')).toBe(1);
      await assertLedgerInvariant(db.orm, walletId);
    },
    TIMEOUT,
  );

  it(
    'mandatory scenario: 100.00 balance, two 80.00 bets in parallel',
    async () => {
      const { walletId, playerId } = await openWallet('100.00');

      const [a, b] = await Promise.all([
        c.submit.execute(bet(walletId, playerId, 'race-a', '80.00')),
        c.submit.execute(bet(walletId, playerId, 'race-b', '80.00')),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
      const rejected = [a, b].find((r) => r.status === WagerTransactionStatus.Rejected);
      expect(rejected?.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);

      const wallet = await c.wallets.findById(db.orm.em.fork(), walletId);
      expect(wallet?.balance.toString()).toBe('20.00');
      expect(await countLedgerEntries(db.orm, walletId, 'DEBIT')).toBe(1);
      await assertLedgerInvariant(db.orm, walletId);
    },
    TIMEOUT,
  );

  it(
    'processes distinct wallets in parallel without interference',
    async () => {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet('50.00')));
      await Promise.all(
        wallets.map((w, i) => c.submit.execute(bet(w.walletId, w.playerId, `w-${i}`, '30.00'))),
      );
      for (const w of wallets) {
        const wallet = await c.wallets.findById(db.orm.em.fork(), w.walletId);
        expect(wallet?.balance.toString()).toBe('20.00');
        await assertLedgerInvariant(db.orm, w.walletId);
      }
    },
    TIMEOUT,
  );
});
