import { Module } from '@nestjs/common';
import { MessagingPersistenceModule } from '../messaging/messaging-persistence.module.ts';
import { OutboxPublisherWorker } from '../messaging/outbox/outbox-publisher.worker.ts';
import { FaultInjector } from '../messaging/sqs/fault-injector.ts';
import { WagerTransactionsConsumer } from '../messaging/sqs/wager-transactions.consumer.ts';
import { ResolvePendingReferencesJob } from '../wagering/application/resolve-pending-references.job.ts';
import { WageringPersistenceModule } from '../wagering/wagering-persistence.module.ts';
import { WageringModule } from '../wagering/wagering.module.ts';
import { WalletModule } from '../wallet/wallet.module.ts';

/**
 * Background workers: the SQS consumer, the outbox publisher and the
 * pending-reference resolver. They start on module init only when APP_ROLE is
 * `worker` or `all` (each worker checks the role). Every worker also drains on
 * SIGTERM via OnApplicationShutdown.
 */
@Module({
  imports: [WageringModule, WalletModule, WageringPersistenceModule, MessagingPersistenceModule],
  providers: [
    FaultInjector,
    WagerTransactionsConsumer,
    OutboxPublisherWorker,
    ResolvePendingReferencesJob,
  ],
})
export class WorkerModule {}
