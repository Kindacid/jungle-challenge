import type { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../database/transaction-runner.ts';
import type { EventContext, IntegrationEvent } from '../../messaging/events/integration-event.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../messaging/events/wagering-events.ts';
import { InboxMessage } from '../../messaging/inbox/inbox-message.ts';
import { InboxRepository } from '../../messaging/infrastructure/inbox.repository.ts';
import { OutboxRepository } from '../../messaging/infrastructure/outbox.repository.ts';
import { OutboxMessage } from '../../messaging/outbox/outbox-message.ts';
import { MetricsPort } from '../../observability/metrics-port.ts';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../shared/application/application-errors.ts';
import { canonicalHash } from '../../shared/domain/canonical-json.ts';
import { Clock } from '../../shared/domain/clock.ts';
import { IdGenerator } from '../../shared/domain/id-generator.ts';
import type { Money } from '../../shared/domain/money.ts';
import { LedgerDirection } from '../../wallet/domain/ledger-direction.ts';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.ts';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository.ts';
import type { FailureCode } from '../domain/failure-code.ts';
import { WagerProcessor } from '../domain/wager-processor.ts';
import type { WagerTransactionKind } from '../domain/wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.ts';
import { WagerTransaction } from '../domain/wager-transaction.ts';
import { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository.ts';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

/** Initial wait before the first pending-reference retry. */
const PENDING_REFERENCE_INITIAL_DELAY_MS = 2_000;

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  /** Present for SQS-sourced commands; drives inbox dedup. Absent for HTTP. */
  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: Money;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/**
 * The single use case shared by the HTTP endpoint and the SQS consumer. It owns
 * the atomic unit of work: inbox dedup, idempotency, the per-wallet pessimistic
 * lock, the business decision, the balance+ledger+transaction writes, and the
 * outbox events — all in one SQL transaction. Nothing is published before commit.
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly inbox: InboxRepository,
    private readonly outbox: OutboxRepository,
    private readonly processor: WagerProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: MetricsPort,
  ) {}

  async execute(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const startedAt = Date.now();
    const payloadHash = this.buildPayloadHash(command);

    const result = await this.txRunner.run(
      async (em) => {
        const now = this.clock.now();

        // 1. SQS deduplication: the inbox row is the dedup guarantee.
        if (command.inbox) {
          const inserted = await this.inbox.tryInsert(
            em,
            InboxMessage.receive({
              consumerName: command.inbox.consumerName,
              messageId: command.inbox.messageId,
              payloadHash,
              receivedAt: now,
            }),
          );
          if (!inserted) {
            const existing = await this.transactions.findByIdempotencyKey(
              em,
              command.idempotencyKey,
            );
            this.metrics.incIdempotentDuplicate('sqs');
            if (existing) return this.replayResult(existing);
            // Inbox row exists without a transaction — a prior attempt committed
            // the dedup row but not the effect (should not happen in one tx). Treat
            // as already handled to avoid reprocessing.
            throw new WalletNotFoundError(
              `duplicate message ${command.inbox.messageId} without a recorded transaction`,
            );
          }
        }

        // 2. Idempotency pre-check (no lock needed for a clean replay).
        const pre = await this.transactions.findByIdempotencyKey(em, command.idempotencyKey);
        if (pre) return this.handleExisting(em, command, pre, payloadHash, now, 'http');

        // 3. Lock the wallet — the unit of concurrency.
        const wallet = await this.wallets.findForUpdate(em, command.walletId);
        if (!wallet) {
          throw new WalletNotFoundError(`wallet ${command.walletId} not found`);
        }

        // 4. Re-check idempotency under the lock (closes the submit race).
        const again = await this.transactions.findByIdempotencyKey(em, command.idempotencyKey);
        if (again) return this.handleExisting(em, command, again, payloadHash, now, 'http');

        // 5. Build the transaction (born PENDING; validates reference presence).
        const tx = WagerTransaction.create({
          id: this.ids.next(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money: command.money,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          createdAt: now,
        });

        // 6. Resolve the reference, if any.
        let reference: WagerTransaction | null = null;
        let referenceAlreadyReversed = false;
        if (command.referenceExternalTransactionId) {
          reference = await this.transactions.findByProviderExternalId(
            em,
            command.providerId,
            command.referenceExternalTransactionId,
          );
          if (reference) {
            referenceAlreadyReversed = await this.transactions.hasProcessedReversal(
              em,
              reference.id,
            );
          }
        }

        // 7. Decide (pure domain).
        const decision = this.processor.decide({
          wallet,
          transaction: tx,
          reference,
          referenceAlreadyReversed,
        });

        const events: IntegrationEvent<unknown>[] = [];
        let outcome: SubmitWagerResult;

        if (decision.type === 'processed') {
          let entry: WalletLedgerEntry | undefined;
          if (decision.direction === LedgerDirection.Debit) {
            entry = wallet.debit(command.money, {
              transactionId: tx.id,
              ledgerEntryId: this.ids.next(),
              at: now,
            });
          } else if (decision.direction === LedgerDirection.Credit) {
            entry = wallet.credit(command.money, {
              transactionId: tx.id,
              ledgerEntryId: this.ids.next(),
              at: now,
            });
          }
          const observed = wallet.balance;
          tx.markProcessed(decision.referenceTransactionId, now, observed);

          await this.transactions.insert(em, tx, { correlationId: command.correlationId });
          if (entry) {
            await this.wallets.applyBalance(em, wallet);
            await this.wallets.insertLedgerEntry(em, entry);
          }

          // Wake any transactions parked waiting on THIS one as their reference
          // (out-of-order delivery) so the resolver retries them promptly. This
          // is an optimization; the scheduled worker is the real guarantee.
          await this.transactions.nudgeDependents(
            em,
            command.providerId,
            command.externalTransactionId,
            now,
          );

          events.push(
            WagerTransactionProcessed.from(
              tx,
              observed.toJSON(),
              entry !== undefined,
              this.eventCtx(command, now, tx.id),
            ),
          );
          if (entry) {
            events.push(
              WalletBalanceChanged.from(wallet, entry, this.eventCtx(command, now, tx.id)),
            );
          }
          outcome = {
            transactionId: tx.id,
            status: WagerTransactionStatus.Processed,
            balance: observed,
            idempotentReplay: false,
          };
        } else if (decision.type === 'rejected') {
          const observed = wallet.balance;
          tx.reject(decision.code, observed);
          await this.transactions.insert(em, tx, { correlationId: command.correlationId });
          events.push(
            WagerTransactionRejected.from(tx, decision.code, this.eventCtx(command, now, tx.id)),
          );
          outcome = {
            transactionId: tx.id,
            status: WagerTransactionStatus.Rejected,
            balance: observed,
            failureCode: decision.code,
            idempotentReplay: false,
          };
        } else {
          // pending_reference
          tx.markPendingReference();
          const nextAttemptAt = new Date(now.getTime() + PENDING_REFERENCE_INITIAL_DELAY_MS);
          await this.transactions.insert(em, tx, {
            correlationId: command.correlationId,
            referenceAttempts: 0,
            nextReferenceAttemptAt: nextAttemptAt,
          });
          events.push(
            WagerTransactionPendingReference.from(tx, this.eventCtx(command, now, tx.id)),
          );
          outcome = {
            transactionId: tx.id,
            status: WagerTransactionStatus.PendingReference,
            balance: wallet.balance,
            idempotentReplay: false,
          };
        }

        // 9. Outbox (same transaction — published only after commit).
        await this.outbox.insertMany(
          em,
          events.map((e) => OutboxMessage.enqueue(e)),
        );

        // 10. Mark the inbox row processed.
        if (command.inbox) {
          await this.inbox.markProcessed(
            em,
            command.inbox.consumerName,
            command.inbox.messageId,
            now,
            tx.id,
          );
        }

        this.metrics.incTransaction(tx.kind, outcome.status);
        return outcome;
      },
      {
        onRetry: ({ kind }) => {
          this.metrics.incLockConflict(kind);
          this.metrics.incRetry('submit-wager', kind);
        },
      },
    );

    this.metrics.observeProcessing('submit-wager', (Date.now() - startedAt) / 1000);
    return result;
  }

  /** Replay or conflict for an already-recorded transaction. */
  private async handleExisting(
    em: EntityManager,
    command: SubmitWagerCommand,
    existing: WagerTransaction,
    payloadHash: string,
    now: Date,
    source: 'http' | 'sqs',
  ): Promise<SubmitWagerResult> {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        `idempotency key ${command.idempotencyKey} was used with a different payload`,
      );
    }
    this.metrics.incIdempotentDuplicate(source);
    if (command.inbox) {
      await this.inbox.markProcessed(
        em,
        command.inbox.consumerName,
        command.inbox.messageId,
        now,
        existing.id,
      );
    }
    return this.replayResult(existing);
  }

  private replayResult(tx: WagerTransaction): SubmitWagerResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: tx.observedBalance ?? tx.money, // observedBalance is always set on terminal
      failureCode: tx.failureCode,
      idempotentReplay: true,
    };
  }

  private eventCtx(command: SubmitWagerCommand, now: Date, causationId: string): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId,
      occurredAt: now,
    };
  }

  private buildPayloadHash(command: SubmitWagerCommand): string {
    // Canonical hash of the BUSINESS subset only — not the Idempotency-Key header
    // nor any transport metadata. Keys are sorted recursively inside canonicalize.
    return canonicalHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });
  }
}
