import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FaultInjector } from '../../src/messaging/sqs/fault-injector.ts';
import { WagerTransactionsConsumer } from '../../src/messaging/sqs/wager-transactions.consumer.ts';
import { NoopMetrics } from '../../src/observability/metrics-port.ts';
import { Money } from '../../src/shared/domain/money.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status.ts';
import { type TestContainer, buildContainer, uuid } from '../support/container.ts';
import { type TestDatabase, createTestDatabase } from '../support/database.ts';
import { assertLedgerInvariant, countLedgerEntries } from '../support/invariants.ts';
import { type TestQueues, createTestQueues } from '../support/sqs.ts';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const TIMEOUT = 30_000;

let db: TestDatabase;
let c: TestContainer;
let q: TestQueues;
let consumer: WagerTransactionsConsumer;

beforeAll(async () => {
  db = await createTestDatabase();
  c = buildContainer(db.orm);
  q = await createTestQueues();
  consumer = new WagerTransactionsConsumer(
    q.config,
    q.sqs,
    c.submit,
    new NoopMetrics(),
    new FaultInjector(q.config),
  );
});

afterAll(async () => {
  q?.cleanup();
  await db?.teardown();
});

function validMessage(walletId: string, playerId: string, ext: string, amount: string): string {
  return JSON.stringify({
    messageId: `m-${ext}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'p',
      externalTransactionId: ext,
      idempotencyKey: `p:${ext}`,
      playerId,
      walletId,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  });
}

describe('SQS consumer (MiniStack)', () => {
  it(
    'consumes a valid message, applies the effect, and acks',
    async () => {
      const playerId = uuid();
      const w = await c.createWallet.execute({
        playerId,
        initialBalance: brl('100.00'),
        correlationId: uuid(),
      });
      const ext = `ok-${uuid()}`;

      await q.sqs.send(q.mainUrl, validMessage(w.id, playerId, ext, '30.00'), {
        messageGroupId: w.id,
        messageDeduplicationId: `m-${ext}`,
      });

      // Drive the consumer until it has handled the message.
      for (
        let i = 0;
        i < 10 && !(await c.transactions.findByProviderExternalId(db.orm.em.fork(), 'p', ext));
        i++
      ) {
        await consumer.pollOnce();
      }

      const tx = await c.transactions.findByProviderExternalId(db.orm.em.fork(), 'p', ext);
      expect(tx?.status).toBe(WagerTransactionStatus.Processed);
      expect((await c.wallets.findById(db.orm.em.fork(), w.id))?.balance.toString()).toBe('70.00');
      expect(await countLedgerEntries(db.orm, w.id, 'DEBIT')).toBe(1);
      await assertLedgerInvariant(db.orm, w.id);
    },
    TIMEOUT,
  );

  it(
    'routes a malformed message to the DLQ with an errorCode',
    async () => {
      await q.sqs.send(q.mainUrl, '{not valid json', {
        messageGroupId: 'bad-group',
        messageDeduplicationId: `bad-${uuid()}`,
      });

      // Process until the DLQ receives it.
      let dlqMessages = await q.sqs.receive(q.dlqUrl, 10, 1, 5);
      for (let i = 0; i < 10 && dlqMessages.length === 0; i++) {
        await consumer.pollOnce();
        dlqMessages = await q.sqs.receive(q.dlqUrl, 10, 1, 5);
      }

      expect(dlqMessages.length).toBeGreaterThanOrEqual(1);
      const attrs = dlqMessages[0]?.MessageAttributes;
      expect(attrs?.errorCode?.StringValue).toBe('INVALID_PAYLOAD');
    },
    TIMEOUT,
  );
});
