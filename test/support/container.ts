import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmTransactionRunner } from '../../src/database/transaction-runner.ts';
import { InboxRepository } from '../../src/messaging/infrastructure/inbox.repository.ts';
import { OutboxRepository } from '../../src/messaging/infrastructure/outbox.repository.ts';
import { NoopMetrics } from '../../src/observability/metrics-port.ts';
import { SystemClock } from '../../src/shared/domain/clock.ts';
import { Uuidv7Generator } from '../../src/shared/domain/id-generator.ts';
import { SubmitWagerTransactionUseCase } from '../../src/wagering/application/submit-wager-transaction.use-case.ts';
import { WagerProcessor } from '../../src/wagering/domain/wager-processor.ts';
import { WagerTransactionRepository } from '../../src/wagering/infrastructure/persistence/wager-transaction.repository.ts';
import { CreateWalletUseCase } from '../../src/wallet/application/create-wallet.use-case.ts';
import { WalletRepository } from '../../src/wallet/infrastructure/persistence/wallet.repository.ts';

/** Wire the real use cases against a test ORM — no Nest, no mocks of PG. */
export function buildContainer(orm: MikroORM) {
  const txRunner = new MikroOrmTransactionRunner(orm, 8);
  const wallets = new WalletRepository();
  const transactions = new WagerTransactionRepository();
  const inbox = new InboxRepository();
  const outbox = new OutboxRepository();
  const processor = new WagerProcessor();
  const ids = new Uuidv7Generator();
  const clock = new SystemClock();
  const metrics = new NoopMetrics();

  const submit = new SubmitWagerTransactionUseCase(
    txRunner,
    wallets,
    transactions,
    inbox,
    outbox,
    processor,
    ids,
    clock,
    metrics,
  );
  const createWallet = new CreateWalletUseCase(txRunner, wallets, transactions, outbox, ids, clock);

  return {
    txRunner,
    wallets,
    transactions,
    inbox,
    outbox,
    processor,
    ids,
    clock,
    metrics,
    submit,
    createWallet,
  };
}

export type TestContainer = ReturnType<typeof buildContainer>;

/** Fresh UUIDv7 helper for ids in tests. */
export function uuid(): string {
  return new Uuidv7Generator().next();
}
