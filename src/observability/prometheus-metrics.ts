import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { MetricsPort } from './metrics-port.ts';

/**
 * Prometheus-backed metrics. Covers (at least) the signals the challenge asks
 * for: transactions by status, duplicates, retries, DLQ, lock conflicts, outbox
 * lag and processing latency, plus reconciliation divergences.
 */
@Injectable()
export class PrometheusMetrics extends MetricsPort {
  readonly registry = new Registry();

  private readonly transactions: Counter<string>;
  private readonly duplicates: Counter<string>;
  private readonly retries: Counter<string>;
  private readonly lockConflicts: Counter<string>;
  private readonly dlq: Counter<string>;
  private readonly reconciliationDivergences: Counter<string>;
  private readonly processing: Histogram<string>;
  private readonly outboxLag: Gauge<string>;
  private readonly outboxPending: Gauge<string>;

  constructor() {
    super();
    collectDefaultMetrics({ register: this.registry });

    this.transactions = new Counter({
      name: 'wager_transactions_total',
      help: 'Wager transactions by kind and outcome status',
      labelNames: ['kind', 'status'],
      registers: [this.registry],
    });
    this.duplicates = new Counter({
      name: 'idempotency_duplicates_total',
      help: 'Duplicate submissions detected (replays)',
      labelNames: ['source'],
      registers: [this.registry],
    });
    this.retries = new Counter({
      name: 'retries_total',
      help: 'Retries by component and reason',
      labelNames: ['component', 'reason'],
      registers: [this.registry],
    });
    this.lockConflicts = new Counter({
      name: 'lock_conflicts_total',
      help: 'Lock/serialization conflicts by SQLSTATE class',
      labelNames: ['sqlstate'],
      registers: [this.registry],
    });
    this.dlq = new Counter({
      name: 'dlq_messages_total',
      help: 'Messages routed to the DLQ by reason',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.reconciliationDivergences = new Counter({
      name: 'wallet_reconciliation_divergences_total',
      help: 'Reconciliation checks that found a divergence',
      registers: [this.registry],
    });
    this.processing = new Histogram({
      name: 'wager_processing_duration_seconds',
      help: 'Processing latency by component',
      labelNames: ['component'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });
    this.outboxLag = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age of the oldest unpublished outbox event',
      registers: [this.registry],
    });
    this.outboxPending = new Gauge({
      name: 'outbox_pending',
      help: 'Number of unpublished outbox events',
      registers: [this.registry],
    });
  }

  incTransaction(kind: string, status: string): void {
    this.transactions.inc({ kind, status });
  }
  incIdempotentDuplicate(source: 'http' | 'sqs'): void {
    this.duplicates.inc({ source });
  }
  incRetry(component: string, reason: string): void {
    this.retries.inc({ component, reason });
  }
  incLockConflict(sqlstate: string): void {
    this.lockConflicts.inc({ sqlstate });
  }
  observeProcessing(component: string, seconds: number): void {
    this.processing.observe({ component }, seconds);
  }
  incDlq(reason: string): void {
    this.dlq.inc({ reason });
  }
  setOutboxLag(seconds: number): void {
    this.outboxLag.set(seconds);
  }
  setOutboxPending(count: number): void {
    this.outboxPending.set(count);
  }
  incReconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
