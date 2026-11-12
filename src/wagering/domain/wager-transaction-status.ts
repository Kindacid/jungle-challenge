export enum WagerTransactionStatus {
  /** Accepted, not yet applied. */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to arrive (out-of-order delivery). */
  PendingReference = 'PENDING_REFERENCE',
  /** Applied — terminal. */
  Processed = 'PROCESSED',
  /** Rejected by a business rule — terminal. */
  Rejected = 'REJECTED',
  /** Permanent infrastructure error — terminal, auditable. */
  Failed = 'FAILED',
}

export const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
