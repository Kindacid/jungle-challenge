import type { EntityManager } from '@mikro-orm/postgresql';
import { type OutboxMessageRecord, outboxMessageSchema } from '../../database/records.ts';
import { OutboxMessage } from '../outbox/outbox-message.ts';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
  last_error: string | null;
}

function rowToDomain(r: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregate_id,
    eventType: r.event_type,
    eventVersion: r.event_version,
    payload: r.payload,
    correlationId: r.correlation_id ?? '',
    occurredAt: new Date(r.occurred_at),
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : undefined,
    publishedAt: r.published_at ? new Date(r.published_at) : undefined,
    lastError: r.last_error ?? undefined,
  });
}

export class OutboxRepository {
  /** Insert pending events as part of the caller's transaction. */
  async insertMany(em: EntityManager, messages: OutboxMessage[]): Promise<void> {
    for (const m of messages) {
      await em.execute(
        `INSERT INTO outbox_messages
           (id, aggregate_id, event_type, event_version, payload, correlation_id, occurred_at, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, CAST(? AS jsonb), ?, ?, ?, ?)`,
        [
          m.id,
          m.aggregateId,
          m.eventType,
          m.eventVersion,
          JSON.stringify(m.payload),
          m.correlationId,
          m.occurredAt,
          m.attempts,
          m.nextAttemptAt ?? m.occurredAt,
        ],
      );
    }
  }

  /**
   * Atomically lease a batch of due, unpublished messages. FOR UPDATE SKIP LOCKED
   * lets many publishers run concurrently without contending on the same rows.
   */
  async claimBatch(
    em: EntityManager,
    lockedBy: string,
    leaseSeconds: number,
    batchSize: number,
    now: Date,
  ): Promise<OutboxMessage[]> {
    // Compute the lease expiry in JS and bind it as a timestamp — avoids binding
    // a Date into interval arithmetic, which Postgres reads as text.
    const lockedUntil = new Date(now.getTime() + leaseSeconds * 1000);
    const rows = (await em.execute(
      `UPDATE outbox_messages o
         SET locked_until = ?,
             locked_by = ?
       WHERE o.id IN (
         SELECT id FROM outbox_messages
          WHERE published_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (locked_until IS NULL OR locked_until < ?)
          ORDER BY sequence
          LIMIT ?
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, aggregate_id, event_type, event_version, payload,
                 correlation_id, occurred_at, attempts, next_attempt_at,
                 published_at, last_error`,
      [lockedUntil, lockedBy, now, now, batchSize],
    )) as OutboxRow[];
    return rows.map(rowToDomain);
  }

  async markPublished(em: EntityManager, id: string, at: Date): Promise<void> {
    await em.nativeUpdate<OutboxMessageRecord>(
      outboxMessageSchema,
      { id },
      { publishedAt: at, lockedUntil: null, lockedBy: null, lastError: null },
    );
  }

  async scheduleRetry(em: EntityManager, msg: OutboxMessage): Promise<void> {
    await em.nativeUpdate<OutboxMessageRecord>(
      outboxMessageSchema,
      { id: msg.id },
      {
        attempts: msg.attempts,
        nextAttemptAt: msg.nextAttemptAt ?? null,
        lastError: msg.lastError ?? null,
        lockedUntil: null,
        lockedBy: null,
      },
    );
  }

  /** Release any leases held by this instance (graceful shutdown). */
  async releaseLeases(em: EntityManager, lockedBy: string): Promise<void> {
    await em.nativeUpdate<OutboxMessageRecord>(
      outboxMessageSchema,
      { lockedBy, publishedAt: null },
      { lockedUntil: null, lockedBy: null },
    );
  }

  /** Lag metrics: number of pending events and the oldest pending occurredAt. */
  async pendingStats(
    em: EntityManager,
  ): Promise<{ pending: number; oldestOccurredAt: Date | null }> {
    const rows = (await em.execute(
      `SELECT COUNT(*)::int AS pending, MIN(occurred_at) AS oldest
         FROM outbox_messages WHERE published_at IS NULL`,
    )) as Array<{ pending: number; oldest: Date | null }>;
    const row = rows[0];
    return {
      pending: row?.pending ?? 0,
      oldestOccurredAt: row?.oldest ? new Date(row.oldest) : null,
    };
  }
}
