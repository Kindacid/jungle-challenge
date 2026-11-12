import type { WagerTransactionRecord } from '../../../database/records.ts';
import { Money } from '../../../shared/domain/money.ts';
import type { FailureCode } from '../../domain/failure-code.ts';
import type { WagerTransactionKind } from '../../domain/wager-transaction-kind.ts';
import type { WagerTransactionStatus } from '../../domain/wager-transaction-status.ts';
import { WagerTransaction } from '../../domain/wager-transaction.ts';

/** Persistence-only fields not owned by the domain entity. */
export interface WagerTransactionPersistenceExtras {
  correlationId?: string | null;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date | null;
}

export function wagerTxToDomain(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId ?? '',
    gameId: r.gameId ?? '',
    kind: r.kind as WagerTransactionKind,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode as FailureCode | null) ?? undefined,
    processedAt: r.processedAt ?? undefined,
    observedBalance:
      r.observedBalanceAmount !== null
        ? Money.from({ amount: r.observedBalanceAmount, currency: r.currency })
        : undefined,
  });
}

export function wagerTxToRecord(
  tx: WagerTransaction,
  extras: WagerTransactionPersistenceExtras = {},
): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    observedBalanceAmount: tx.observedBalance?.toString() ?? null,
    referenceAttempts: extras.referenceAttempts ?? 0,
    nextReferenceAttemptAt: extras.nextReferenceAttemptAt ?? null,
    correlationId: extras.correlationId ?? null,
    createdAt: tx.createdAt,
    processedAt: tx.processedAt ?? null,
  };
}
