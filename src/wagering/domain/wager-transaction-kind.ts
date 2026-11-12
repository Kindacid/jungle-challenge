/** The operations a provider can submit, plus the internal OPENING credit. */
export enum WagerTransactionKind {
  /** Internal: opening credit created when a wallet is opened with funds. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/** Kinds that may be submitted externally (OPENING is internal only). */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export function isSubmittableKind(kind: string): kind is WagerTransactionKind {
  return (SUBMITTABLE_KINDS as readonly string[]).includes(kind);
}
