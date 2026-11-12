/**
 * Stable, machine-readable rejection/failure taxonomy. A provider reads the code
 * (never the message) to decide whether to resend, fix the payload, or give up.
 * Each code declares whether a plain resend could succeed (`retryable`) and
 * whether the provider must change the payload (`fixPayload`).
 */
export enum FailureCode {
  // ---- balance ----
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  REVERSAL_INSUFFICIENT_FUNDS = 'REVERSAL_INSUFFICIENT_FUNDS',

  // ---- identity / currency ----
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  WALLET_PLAYER_MISMATCH = 'WALLET_PLAYER_MISMATCH',

  // ---- references ----
  REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',
  REFERENCE_MISMATCH = 'REFERENCE_MISMATCH',
  REFERENCE_KIND_NOT_ALLOWED = 'REFERENCE_KIND_NOT_ALLOWED',
  REFERENCE_NOT_PROCESSED = 'REFERENCE_NOT_PROCESSED',
  REFERENCE_AMOUNT_MISMATCH = 'REFERENCE_AMOUNT_MISMATCH',
  ALREADY_REVERSED = 'ALREADY_REVERSED',

  // ---- infrastructure (FAILED, not REJECTED) ----
  PROCESSING_RETRIES_EXHAUSTED = 'PROCESSING_RETRIES_EXHAUSTED',
}

export interface FailureCodeMeta {
  /** Could an identical resend eventually succeed without changes? */
  retryable: boolean;
  /** Must the provider change the payload for a resend to succeed? */
  fixPayload: boolean;
  description: string;
}

export const FAILURE_CODE_META: Record<FailureCode, FailureCodeMeta> = {
  [FailureCode.INSUFFICIENT_FUNDS]: {
    retryable: false,
    fixPayload: false,
    description: 'Wallet balance is lower than the bet amount.',
  },
  [FailureCode.REVERSAL_INSUFFICIENT_FUNDS]: {
    retryable: false,
    fixPayload: false,
    description: 'Reversing would drive the balance negative (funds already spent).',
  },
  [FailureCode.CURRENCY_MISMATCH]: {
    retryable: false,
    fixPayload: true,
    description: 'Operation currency differs from the wallet currency.',
  },
  [FailureCode.WALLET_PLAYER_MISMATCH]: {
    retryable: false,
    fixPayload: true,
    description: 'walletId does not belong to the given playerId.',
  },
  [FailureCode.REFERENCE_NOT_FOUND]: {
    retryable: false,
    fixPayload: true,
    description: 'Referenced transaction never arrived within the retry window.',
  },
  [FailureCode.REFERENCE_MISMATCH]: {
    retryable: false,
    fixPayload: true,
    description: 'Reference belongs to a different player/wallet/currency/round.',
  },
  [FailureCode.REFERENCE_KIND_NOT_ALLOWED]: {
    retryable: false,
    fixPayload: true,
    description: 'Reference kind cannot be reversed by this operation.',
  },
  [FailureCode.REFERENCE_NOT_PROCESSED]: {
    retryable: false,
    fixPayload: false,
    description: 'Reference exists but is not in a PROCESSED state.',
  },
  [FailureCode.REFERENCE_AMOUNT_MISMATCH]: {
    retryable: false,
    fixPayload: true,
    description: 'Reversal amount must equal the referenced amount (no partials).',
  },
  [FailureCode.ALREADY_REVERSED]: {
    retryable: false,
    fixPayload: false,
    description: 'Reference has already been reversed by a prior operation.',
  },
  [FailureCode.PROCESSING_RETRIES_EXHAUSTED]: {
    retryable: false,
    fixPayload: false,
    description: 'Permanent infrastructure failure after exhausting retries.',
  },
};
