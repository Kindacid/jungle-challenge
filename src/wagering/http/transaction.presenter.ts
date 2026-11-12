import type { WagerTransaction } from '../domain/wager-transaction.ts';

/** Shared JSON shape for a transaction returned by the query endpoints. */
export function presentTransaction(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    observedBalance: tx.observedBalance?.toJSON(),
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString(),
  };
}
