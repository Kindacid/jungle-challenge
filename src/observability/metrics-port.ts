/**
 * Metrics port used by use cases and workers. A Prometheus-backed implementation
 * is provided in infrastructure; tests use the no-op. Keeping it an abstract port
 * means the application layer never imports prom-client directly.
 */
export abstract class MetricsPort {
  abstract incTransaction(kind: string, status: string): void;
  abstract incIdempotentDuplicate(source: 'http' | 'sqs'): void;
  abstract incRetry(component: string, reason: string): void;
  abstract incLockConflict(sqlstate: string): void;
  abstract observeProcessing(component: string, seconds: number): void;
  abstract incDlq(reason: string): void;
  abstract setOutboxLag(seconds: number): void;
  abstract setOutboxPending(count: number): void;
  abstract incReconciliationDivergence(): void;
}

/** Does nothing; used in unit tests and when metrics are disabled. */
export class NoopMetrics extends MetricsPort {
  incTransaction(): void {}
  incIdempotentDuplicate(): void {}
  incRetry(): void {}
  incLockConflict(): void {}
  observeProcessing(): void {}
  incDlq(): void {}
  setOutboxLag(): void {}
  setOutboxPending(): void {}
  incReconciliationDivergence(): void {}
}
