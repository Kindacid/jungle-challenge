import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.ts';
import { TransactionRunner } from '../../database/transaction-runner.ts';
import { MetricsPort } from '../../observability/metrics-port.ts';
import { Clock } from '../../shared/domain/clock.ts';
import { OutboxRepository } from '../infrastructure/outbox.repository.ts';
import { SqsGateway } from '../sqs/sqs-client.ts';
import type { OutboxMessage } from './outbox-message.ts';

/**
 * Publishes pending outbox events to the events FIFO queue. Lease-based so many
 * publishers run concurrently (FOR UPDATE SKIP LOCKED) without double-claiming.
 *
 * Crash safety: the event is published to SQS BEFORE `published_at` is set. If
 * the process dies in between, the lease expires and another instance
 * republishes — delivery is at-least-once, and consumers dedupe by eventId
 * (MessageDeduplicationId on the FIFO queue).
 */
@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly txRunner: TransactionRunner,
    private readonly outbox: OutboxRepository,
    private readonly sqs: SqsGateway,
    private readonly metrics: MetricsPort,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    if (this.config.role === 'api') return;
    this.running = true;
    this.loop = this.runLoop();
    this.logger.log('outbox publisher started');
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.loop) return; // never started on this instance (e.g. api-only role)
    this.running = false;
    await this.loop;
    // Release any leases we still hold so another instance can take over quickly.
    try {
      await this.txRunner.run((em) => this.outbox.releaseLeases(em, this.config.instanceId));
    } catch (err) {
      this.logger.error(`failed to release outbox leases: ${asMessage(err)}`);
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const published = await this.drainOnce();
        await this.updateLagMetrics();
        if (published === 0) await delay(this.config.worker.outboxPollMs);
      } catch (err) {
        this.logger.error(`outbox loop error: ${asMessage(err)}`);
        await delay(this.config.worker.outboxPollMs);
      }
    }
  }

  /** Claim and publish one batch; returns how many were published. */
  private async drainOnce(): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.txRunner.run((em) =>
      this.outbox.claimBatch(
        em,
        this.config.instanceId,
        this.config.worker.outboxLeaseSeconds,
        this.config.worker.outboxBatchSize,
        now,
      ),
    );

    let published = 0;
    for (const message of claimed) {
      const ok = await this.publishOne(message);
      if (ok) published += 1;
    }
    return published;
  }

  private async publishOne(message: OutboxMessage): Promise<boolean> {
    try {
      await this.sqs.send(this.config.sqs.eventsQueueUrl, JSON.stringify(message.payload), {
        messageGroupId: message.aggregateId,
        messageDeduplicationId: message.id,
      });
    } catch (err) {
      message.scheduleRetry(this.clock.now(), asMessage(err));
      this.metrics.incRetry('outbox', 'publish_failed');
      await this.txRunner.run((em) => this.outbox.scheduleRetry(em, message));
      this.logger.warn(`publish failed for ${message.eventType} ${message.id}: ${asMessage(err)}`);
      return false;
    }

    await this.txRunner.run((em) => this.outbox.markPublished(em, message.id, this.clock.now()));
    return true;
  }

  private async updateLagMetrics(): Promise<void> {
    try {
      const stats = await this.txRunner.run((em) => this.outbox.pendingStats(em));
      this.metrics.setOutboxPending(stats.pending);
      const lag = stats.oldestOccurredAt
        ? Math.max(0, (this.clock.now().getTime() - stats.oldestOccurredAt.getTime()) / 1000)
        : 0;
      this.metrics.setOutboxLag(lag);
    } catch {
      /* metrics are best-effort */
    }
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
