import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.ts';
import { TransactionRunner } from '../../database/transaction-runner.ts';
import type { EventContext, IntegrationEvent } from '../../messaging/events/integration-event.ts';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../messaging/events/wagering-events.ts';
import { OutboxRepository } from '../../messaging/infrastructure/outbox.repository.ts';
import { OutboxMessage } from '../../messaging/outbox/outbox-message.ts';
import { MetricsPort } from '../../observability/metrics-port.ts';
import { Clock } from '../../shared/domain/clock.ts';
import { IdGenerator } from '../../shared/domain/id-generator.ts';
import { LedgerDirection } from '../../wallet/domain/ledger-direction.ts';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.ts';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository.ts';
import { WagerProcessor } from '../domain/wager-processor.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository.ts';

/** Exponential backoff for the next reference retry: 2s,4s,… capped at 60s. */
function nextDelayMs(attempts: number): number {
  const base = Math.min(2_000 * 2 ** attempts, 60_000);
  return base + Math.floor(Math.random() * 1_000); // small jitter
}

/**
 * Background worker that re-processes PENDING_REFERENCE transactions whose
 * referenced transaction may now exist (out-of-order delivery). Each candidate is
 * handled in its own transaction: lock the wallet, lock the pending row
 * (SKIP LOCKED), re-run the domain decision, and either apply it, back off, or —
 * once the attempt budget is exhausted — reject with REFERENCE_NOT_FOUND.
 */
@Injectable()
export class ResolvePendingReferencesJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ResolvePendingReferencesJob.name);
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly txRunner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
    private readonly processor: WagerProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: MetricsPort,
  ) {}

  onModuleInit(): void {
    if (this.config.role === 'api') return;
    this.running = true;
    this.loop = this.runLoop();
    this.logger.log('pending-reference resolver started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    if (this.loop) await this.loop;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.logger.error(`resolver tick error: ${err instanceof Error ? err.message : err}`);
      }
      await delay(this.config.worker.pendingReferencePollMs);
    }
  }

  private async tick(): Promise<void> {
    const now = this.clock.now();
    const candidates = await this.txRunner.run((em) =>
      this.transactions.findDuePendingReferences(em, now, 50),
    );
    for (const candidate of candidates) {
      if (!this.running) return;
      await this.resolveOne(candidate.id);
    }
  }

  private async resolveOne(id: string): Promise<void> {
    await this.txRunner.run(async (em) => {
      const now = this.clock.now();
      const locked = await this.transactions.lockPendingForUpdate(em, id);
      if (!locked) return; // resolved or being handled elsewhere
      const { transaction: tx, attempts } = locked;

      const wallet = await this.wallets.findForUpdate(em, tx.walletId);
      if (!wallet) return;

      const reference = tx.referenceExternalTransactionId
        ? await this.transactions.findByProviderExternalId(
            em,
            tx.providerId,
            tx.referenceExternalTransactionId,
          )
        : null;
      const referenceAlreadyReversed = reference
        ? await this.transactions.hasProcessedReversal(em, reference.id)
        : false;

      const exhausted = attempts + 1 >= this.config.worker.pendingReferenceMaxAttempts;
      const decision = this.processor.decide({
        wallet,
        transaction: tx,
        reference,
        referenceAlreadyReversed,
        referenceLookupExhausted: exhausted,
      });

      if (decision.type === 'pending_reference') {
        // Still missing and budget remains: back off and try again later.
        const nextAttemptAt = new Date(now.getTime() + nextDelayMs(attempts + 1));
        await this.transactions.update(em, tx, {
          referenceAttempts: attempts + 1,
          nextReferenceAttemptAt: nextAttemptAt,
        });
        this.metrics.incRetry('pending-reference', 'still_missing');
        return;
      }

      const events: IntegrationEvent<unknown>[] = [];
      if (decision.type === 'processed') {
        let entry: WalletLedgerEntry | undefined;
        if (decision.direction === LedgerDirection.Debit) {
          entry = wallet.debit(tx.money, {
            transactionId: tx.id,
            ledgerEntryId: this.ids.next(),
            at: now,
          });
        } else if (decision.direction === LedgerDirection.Credit) {
          entry = wallet.credit(tx.money, {
            transactionId: tx.id,
            ledgerEntryId: this.ids.next(),
            at: now,
          });
        }
        const observed = wallet.balance;
        tx.markProcessed(decision.referenceTransactionId, now, observed);
        await this.transactions.update(em, tx);
        if (entry) {
          await this.wallets.applyBalance(em, wallet);
          await this.wallets.insertLedgerEntry(em, entry);
        }
        events.push(
          WagerTransactionProcessed.from(
            tx,
            observed.toJSON(),
            entry !== undefined,
            this.eventCtx(tx, now),
          ),
        );
        if (entry) events.push(WalletBalanceChanged.from(wallet, entry, this.eventCtx(tx, now)));
        this.metrics.incTransaction(tx.kind, tx.status);
      } else {
        // rejected
        tx.reject(decision.code, wallet.balance);
        await this.transactions.update(em, tx);
        events.push(WagerTransactionRejected.from(tx, decision.code, this.eventCtx(tx, now)));
        this.metrics.incTransaction(tx.kind, tx.status);
      }

      await this.outbox.insertMany(
        em,
        events.map((e) => OutboxMessage.enqueue(e)),
      );
    });
  }

  private eventCtx(tx: WagerTransaction, now: Date): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: tx.id,
      causationId: tx.id,
      occurredAt: now,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
