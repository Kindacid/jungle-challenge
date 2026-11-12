import type { EntityManager } from '@mikro-orm/postgresql';
import { type WagerTransactionRecord, wagerTransactionSchema } from '../../../database/records.ts';
import { WagerTransactionKind } from '../../domain/wager-transaction-kind.ts';
import { WagerTransactionStatus } from '../../domain/wager-transaction-status.ts';
import type { WagerTransaction } from '../../domain/wager-transaction.ts';
import {
  type WagerTransactionPersistenceExtras,
  wagerTxToDomain,
  wagerTxToRecord,
} from './wager-transaction.mappers.ts';

export class WagerTransactionRepository {
  async insert(
    em: EntityManager,
    tx: WagerTransaction,
    extras: WagerTransactionPersistenceExtras = {},
  ): Promise<void> {
    await em.insert<WagerTransactionRecord>(wagerTransactionSchema, wagerTxToRecord(tx, extras));
  }

  /** Persist a transition / bookkeeping change for a non-terminal transaction. */
  async update(
    em: EntityManager,
    tx: WagerTransaction,
    extras: WagerTransactionPersistenceExtras = {},
  ): Promise<void> {
    await em.nativeUpdate<WagerTransactionRecord>(
      wagerTransactionSchema,
      { id: tx.id },
      {
        status: tx.status,
        failureCode: tx.failureCode ?? null,
        referenceTransactionId: tx.referenceTransactionId ?? null,
        observedBalanceAmount: tx.observedBalance?.toString() ?? null,
        processedAt: tx.processedAt ?? null,
        ...(extras.referenceAttempts !== undefined
          ? { referenceAttempts: extras.referenceAttempts }
          : {}),
        ...(extras.nextReferenceAttemptAt !== undefined
          ? { nextReferenceAttemptAt: extras.nextReferenceAttemptAt }
          : {}),
      },
    );
  }

  async findById(em: EntityManager, id: string): Promise<WagerTransaction | null> {
    const r = await em.findOne<WagerTransactionRecord>(wagerTransactionSchema, { id });
    return r ? wagerTxToDomain(r) : null;
  }

  async findByIdempotencyKey(
    em: EntityManager,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const r = await em.findOne<WagerTransactionRecord>(wagerTransactionSchema, { idempotencyKey });
    return r ? wagerTxToDomain(r) : null;
  }

  async findByProviderExternalId(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const r = await em.findOne<WagerTransactionRecord>(wagerTransactionSchema, {
      providerId,
      externalTransactionId,
    });
    return r ? wagerTxToDomain(r) : null;
  }

  /** Has the given transaction already been reversed (PROCESSED REFUND/ROLLBACK)? */
  async hasProcessedReversal(em: EntityManager, referenceTransactionId: string): Promise<boolean> {
    const count = await em.count<WagerTransactionRecord>(wagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  /** Due PENDING_REFERENCE transactions for the background resolver. */
  async findDuePendingReferences(
    em: EntityManager,
    now: Date,
    limit: number,
  ): Promise<WagerTransaction[]> {
    const rows = await em.find<WagerTransactionRecord>(
      wagerTransactionSchema,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextReferenceAttemptAt: null }, { nextReferenceAttemptAt: { $lte: now } }],
      },
      { orderBy: { nextReferenceAttemptAt: 'asc' }, limit },
    );
    return rows.map(wagerTxToDomain);
  }

  /** Lock a single pending-reference row FOR UPDATE SKIP LOCKED (one worker wins). */
  async lockPendingForUpdate(em: EntityManager, id: string): Promise<WagerTransaction | null> {
    const rows = (await em.execute(
      `SELECT * FROM wager_transactions
         WHERE id = ? AND status = 'PENDING_REFERENCE'
         FOR UPDATE SKIP LOCKED`,
      [id],
    )) as WagerTransactionRecord[];
    const raw = rows[0];
    if (!raw) return null;
    // em.execute returns snake_case columns; map via the schema's field names.
    const mapped = em.map<WagerTransactionRecord>(wagerTransactionSchema, raw);
    return wagerTxToDomain(mapped);
  }

  /** Nudge dependents waiting on a now-available reference so the worker retries soon. */
  async nudgeDependents(
    em: EntityManager,
    providerId: string,
    referenceExternalTransactionId: string,
    at: Date,
  ): Promise<void> {
    await em.nativeUpdate<WagerTransactionRecord>(
      wagerTransactionSchema,
      {
        status: WagerTransactionStatus.PendingReference,
        providerId,
        referenceExternalTransactionId,
      },
      { nextReferenceAttemptAt: at },
    );
  }

  async countByStatus(em: EntityManager, status: WagerTransactionStatus): Promise<number> {
    return em.count<WagerTransactionRecord>(wagerTransactionSchema, { status });
  }
}
