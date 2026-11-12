import type { IntegrationEvent } from '../events/integration-event.ts';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  correlationId: string;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
}

/** Backoff schedule for failed publishes: 1s, 2s, 4s … capped at 5 minutes. */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * A pending integration event stored in the same SQL transaction as the state
 * change that produced it (transactional outbox). A background publisher later
 * delivers it to SQS and marks it published. Delivery is at-least-once; consumers
 * dedupe by eventId.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly eventVersion: number,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly correlationId: string,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
  ) {}

  /** Build an outbox row from a domain integration event. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      envelope as unknown as Readonly<Record<string, unknown>>,
      event.correlationId,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.eventVersion,
      state.payload,
      state.correlationId,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
    this._lastError = undefined;
  }

  /**
   * Record a failed attempt and schedule the next one with exponential backoff
   * (capped). The publisher never gives up on the outbox — a stuck message is
   * surfaced via the outbox-lag metric rather than dropped.
   */
  scheduleRetry(now: Date, error?: string): void {
    this._attempts += 1;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (this._attempts - 1), MAX_BACKOFF_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error;
  }
}
