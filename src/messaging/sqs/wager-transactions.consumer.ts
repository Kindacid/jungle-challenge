import type { Message } from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.ts';
import { classifyPgError, isTransient } from '../../database/pg-error.ts';
import { MetricsPort } from '../../observability/metrics-port.ts';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../shared/application/application-errors.ts';
import { DomainError } from '../../shared/domain/domain-error.ts';
import { Money } from '../../shared/domain/money.ts';
import {
  SubmitWagerTransactionUseCase,
  WAGER_CONSUMER_NAME,
} from '../../wagering/application/submit-wager-transaction.use-case.ts';
import { FaultInjector } from './fault-injector.ts';
import { parseWagerMessage } from './message-contract.ts';
import { SqsGateway } from './sqs-client.ts';

/** Backoff (seconds) for a transient retry based on how many times SQS delivered. */
function visibilityBackoffSeconds(receiveCount: number): number {
  return Math.min(2 ** Math.max(receiveCount, 1), 60);
}

/**
 * Consumes wager messages from the FIFO queue. It reuses the same use case as the
 * HTTP path, dedups via the persistent inbox, and acks ONLY after the SQL commit.
 * Errors are classified: business/replay/duplicate → ack; transient → visibility
 * backoff (redelivery); permanent → DLQ then ack.
 */
@Injectable()
export class WagerTransactionsConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WagerTransactionsConsumer.name);
  private running = false;
  private loop: Promise<void> | null = null;
  private inFlight = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sqs: SqsGateway,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly metrics: MetricsPort,
    private readonly faults: FaultInjector,
  ) {}

  onModuleInit(): void {
    if (this.config.role === 'api') return; // API-only instances do not consume
    this.running = true;
    this.loop = this.runLoop();
    this.logger.log('wager-transactions consumer started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.loop) await this.loop;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.logger.error(`receive failed: ${asMessage(err)}`);
        await delay(1000);
      }
    }
    this.logger.log(`consumer loop stopped (in-flight=${this.inFlight})`);
  }

  /**
   * Receive and handle one batch of messages. Returns how many were received.
   * Public so tests can drive the consumer deterministically (the loop calls it
   * continuously in production).
   */
  async pollOnce(): Promise<number> {
    const { sqs } = this.config;
    const messages = await this.sqs.receive(
      sqs.wagerQueueUrl,
      sqs.maxMessages,
      sqs.waitTimeSeconds,
      sqs.visibilityTimeoutSeconds,
    );
    for (const message of messages) {
      if (this.running === false && this.loop !== null) {
        // Draining an in-flight batch during shutdown: return to the queue.
        await this.safeChangeVisibility(message, 0);
        continue;
      }
      this.inFlight += 1;
      try {
        await this.handle(message);
      } finally {
        this.inFlight -= 1;
      }
    }
    return messages.length;
  }

  private async handle(message: Message): Promise<void> {
    const body = message.Body ?? '';
    const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);

    let parsed: ReturnType<typeof parseWagerMessage>;
    try {
      parsed = parseWagerMessage(body);
    } catch (err) {
      // Malformed/invalid payload is permanent: route to DLQ and ack.
      await this.deadLetter(message, 'INVALID_PAYLOAD', asMessage(err));
      return;
    }

    try {
      await this.submit.execute({
        idempotencyKey: parsed.data.idempotencyKey,
        providerId: parsed.data.providerId,
        externalTransactionId: parsed.data.externalTransactionId,
        playerId: parsed.data.playerId,
        walletId: parsed.data.walletId,
        roundId: parsed.data.roundId,
        gameId: parsed.data.gameId,
        kind: parsed.data.kind,
        money: Money.from(parsed.data.money),
        referenceExternalTransactionId: parsed.data.referenceExternalTransactionId,
        correlationId: parsed.messageId,
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: parsed.messageId },
      });

      // The effect is committed. Simulated crash-before-ack (test only).
      this.faults.maybeCrashAfterCommit();

      await this.ack(message);
    } catch (err) {
      await this.onHandlingError(message, parsed.data.walletId, receiveCount, err);
    }
  }

  private async onHandlingError(
    message: Message,
    walletId: string,
    receiveCount: number,
    err: unknown,
  ): Promise<void> {
    // Permanent business/validation errors → DLQ (ack).
    if (err instanceof IdempotencyConflictError) {
      await this.deadLetter(message, 'IDEMPOTENCY_CONFLICT', asMessage(err), walletId);
      return;
    }
    if (err instanceof InvalidPayloadError) {
      await this.deadLetter(message, 'INVALID_PAYLOAD', asMessage(err), walletId);
      return;
    }
    if (err instanceof WalletNotFoundError) {
      await this.deadLetter(message, 'WALLET_NOT_FOUND', asMessage(err), walletId);
      return;
    }
    // Domain validation errors (e.g. REFUND without a reference) are permanent —
    // a plain resend will never succeed, so route straight to the DLQ.
    if (err instanceof DomainError) {
      await this.deadLetter(message, err.code, asMessage(err), walletId);
      return;
    }

    // Transient infrastructure errors → visibility backoff for redelivery.
    const transient =
      err instanceof TransientInfrastructureError || isTransient(classifyPgError(err));
    if (transient) {
      this.metrics.incRetry('consumer', 'transient');
      if (receiveCount >= this.config.worker.consumerMaxAttempts) {
        await this.deadLetter(message, 'PROCESSING_RETRIES_EXHAUSTED', asMessage(err), walletId);
        return;
      }
      await this.safeChangeVisibility(message, visibilityBackoffSeconds(receiveCount));
      this.logger.warn(
        `transient error (receive ${receiveCount}): ${asMessage(err)} — backing off`,
      );
      return;
    }

    // Unknown error: treat as transient once, then DLQ via redrive/backoff.
    this.logger.error(`unexpected consumer error: ${asMessage(err)}`);
    await this.safeChangeVisibility(message, visibilityBackoffSeconds(receiveCount));
  }

  private async ack(message: Message): Promise<void> {
    if (message.ReceiptHandle) {
      await this.sqs.deleteMessage(this.config.sqs.wagerQueueUrl, message.ReceiptHandle);
    }
  }

  private async deadLetter(
    message: Message,
    reason: string,
    detail: string,
    walletId?: string,
  ): Promise<void> {
    try {
      await this.sqs.send(this.config.sqs.wagerDlqUrl, message.Body ?? '', {
        messageGroupId: walletId ?? 'dlq',
        messageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
        attributes: { errorCode: reason, detail: detail.slice(0, 200) },
      });
      this.metrics.incDlq(reason);
      this.logger.warn(`dead-lettered message (${reason}): ${detail}`);
    } catch (err) {
      // If we cannot DLQ, do NOT ack — let SQS redeliver (redrive is the backstop).
      this.logger.error(`failed to dead-letter: ${asMessage(err)}`);
      return;
    }
    await this.ack(message);
  }

  private async safeChangeVisibility(message: Message, seconds: number): Promise<void> {
    if (!message.ReceiptHandle) return;
    try {
      await this.sqs.changeMessageVisibility(
        this.config.sqs.wagerQueueUrl,
        message.ReceiptHandle,
        seconds,
      );
    } catch (err) {
      this.logger.error(`changeMessageVisibility failed: ${asMessage(err)}`);
    }
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
