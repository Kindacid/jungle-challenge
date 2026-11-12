import type { LedgerDirection } from '../../wallet/domain/ledger-direction.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import { FailureCode } from './failure-code.ts';
import { WagerTransactionKind } from './wager-transaction-kind.ts';
import { WagerTransactionStatus } from './wager-transaction-status.ts';
import type { WagerTransaction } from './wager-transaction.ts';

/**
 * The pure decision of what to do with a transaction. The processor never
 * mutates the wallet or the transaction — it inspects them and returns one of
 * these outcomes. The application layer applies the decision inside the SQL
 * transaction (debit/credit the wallet, transition the transaction).
 */
export type WagerDecision =
  | {
      type: 'processed';
      /** null for LOSS (no balance movement, no ledger entry). */
      direction: LedgerDirection | null;
      /** Internal id of the resolved reference, if any (WIN/REFUND/ROLLBACK). */
      referenceTransactionId?: string;
    }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending_reference' };

export interface WagerDecisionInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Reference resolved by (providerId, referenceExternalTransactionId), or null. */
  reference: WagerTransaction | null;
  /** Has the reference already been reversed by a prior REFUND/ROLLBACK? */
  referenceAlreadyReversed: boolean;
  /**
   * When true, a still-missing reference becomes a terminal REFERENCE_NOT_FOUND
   * rejection instead of PENDING_REFERENCE. The pending-reference resolver sets
   * this on the final attempt; the first submit leaves it false.
   */
  referenceLookupExhausted?: boolean;
}

const ROLLBACK_ALLOWED_REFERENCE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];

/**
 * Domain service holding the business rules from section 7 of the challenge.
 * Stateless and deterministic: same inputs → same decision.
 */
export class WagerProcessor {
  decide(input: WagerDecisionInput): WagerDecision {
    const { wallet, transaction, reference } = input;

    // --- identity: operation must match the wallet it targets ---------------
    if (transaction.money.currency !== wallet.currency) {
      return { type: 'rejected', code: FailureCode.CURRENCY_MISMATCH };
    }
    if (transaction.playerId !== wallet.playerId) {
      return { type: 'rejected', code: FailureCode.WALLET_PLAYER_MISMATCH };
    }

    // --- reference resolution (REFUND/ROLLBACK mandatory, WIN optional) ------
    const hasNamedReference = transaction.referenceExternalTransactionId !== undefined;
    if (hasNamedReference && reference === null) {
      return input.referenceLookupExhausted
        ? { type: 'rejected', code: FailureCode.REFERENCE_NOT_FOUND }
        : { type: 'pending_reference' };
    }

    if (reference !== null) {
      const referenceCheck = this.validateReference(input);
      if (referenceCheck !== null) {
        return { type: 'rejected', code: referenceCheck };
      }
    }

    // --- apply the movement decision ----------------------------------------
    const referenceTransactionId = reference?.id;

    switch (transaction.kind) {
      case WagerTransactionKind.Loss:
        return { type: 'processed', direction: null, referenceTransactionId };

      case WagerTransactionKind.Bet: {
        if (!wallet.hasSufficientBalance(transaction.money)) {
          return { type: 'rejected', code: FailureCode.INSUFFICIENT_FUNDS };
        }
        return {
          type: 'processed',
          direction: transaction.ledgerDirectionFor(),
          referenceTransactionId,
        };
      }

      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return {
          type: 'processed',
          direction: transaction.ledgerDirectionFor(),
          referenceTransactionId,
        };

      case WagerTransactionKind.Rollback: {
        const direction = transaction.ledgerDirectionFor(reference ?? undefined);
        // A rollback that moves money OUT of the wallet can overdraw.
        if (direction === 'DEBIT' && !wallet.hasSufficientBalance(transaction.money)) {
          return { type: 'rejected', code: FailureCode.REVERSAL_INSUFFICIENT_FUNDS };
        }
        return { type: 'processed', direction, referenceTransactionId };
      }

      default:
        // OPENING never flows through the processor (it is created internally).
        return { type: 'rejected', code: FailureCode.REFERENCE_KIND_NOT_ALLOWED };
    }
  }

  /**
   * Validate a resolved reference against the operation. Returns a FailureCode on
   * violation, or null when the reference is acceptable.
   */
  private validateReference(input: WagerDecisionInput): FailureCode | null {
    const { transaction, reference, referenceAlreadyReversed } = input;
    if (reference === null) return null;

    // Must belong to the same provider, player, wallet, currency and round.
    if (
      reference.providerId !== transaction.providerId ||
      reference.playerId !== transaction.playerId ||
      reference.walletId !== transaction.walletId ||
      reference.money.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return FailureCode.REFERENCE_MISMATCH;
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.REFERENCE_NOT_PROCESSED;
    }

    // WIN's reference is an informational link only — no kind/amount/reuse rules.
    if (transaction.kind === WagerTransactionKind.Win) {
      return null;
    }

    // REFUND and ROLLBACK are true reversals: strict kind, amount and single-use.
    if (transaction.kind === WagerTransactionKind.Refund) {
      if (reference.kind !== WagerTransactionKind.Bet) {
        return FailureCode.REFERENCE_KIND_NOT_ALLOWED;
      }
    } else if (transaction.kind === WagerTransactionKind.Rollback) {
      if (!ROLLBACK_ALLOWED_REFERENCE_KINDS.includes(reference.kind)) {
        return FailureCode.REFERENCE_KIND_NOT_ALLOWED;
      }
    }

    // Amount must equal the reference amount (partial reversals are out of scope).
    if (!transaction.money.equals(reference.money)) {
      return FailureCode.REFERENCE_AMOUNT_MISMATCH;
    }

    // A reference may be reversed at most once by ANY reversal kind. This is
    // stricter than "once per kind" and prevents a BET from being both REFUNDed
    // and ROLLBACKed, which would credit the player twice (documented decision).
    if (referenceAlreadyReversed) {
      return FailureCode.ALREADY_REVERSED;
    }

    return null;
  }
}
