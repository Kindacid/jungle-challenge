import { Module } from '@nestjs/common';
import { InboxRepository } from './infrastructure/inbox.repository.ts';
import { OutboxRepository } from './infrastructure/outbox.repository.ts';

/**
 * Inbox/outbox repositories only (no workers), so feature modules can depend on
 * them without creating a cycle with the worker module.
 */
@Module({
  providers: [InboxRepository, OutboxRepository],
  exports: [InboxRepository, OutboxRepository],
})
export class MessagingPersistenceModule {}
