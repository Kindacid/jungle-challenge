import {
  InvalidInputError,
  InvalidTransactionStateError,
} from '../../shared/domain/domain-error.ts';
import type { Money } from '../../shared/domain/money.ts';
import { LedgerDirection } from '../../wallet/domain/ledger-direction.ts';
import type { FailureCode } from './failure-code.ts';
import { WagerTransactionKind } from './wager-transaction-kind.ts';
import { WagerTransactionStatus, isTerminalStatus } from './wager-transaction-status.ts';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Provider-side id of the referenced transaction (not our internal id). */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  currency: string;
  money: Money;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
}

const REFERENCE_REQUIRED_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/**
 * A single provider operation against a wallet. It owns its own lifecycle state
 * machine; the valid transitions are:
 *
 *   PENDING            -> PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *   PENDING_REFERENCE  -> PROCESSED | REJECTED | FAILED
 *
 * PROCESSED / REJECTED / FAILED are terminal: reaching one of them freezes the
 * transaction. Attempting any further transition is a programming error and
 * throws InvalidTransactionStateError (never a business path).
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
  ) {}

  /** Provider-submitted transaction. Born PENDING. Validates reference presence. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidInputError('OPENING transactions cannot be created via create()');
    }
    const requiresRef = REFERENCE_REQUIRED_KINDS.includes(props.kind);
    if (requiresRef && !props.referenceExternalTransactionId) {
      throw new InvalidInputError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (!requiresRef && props.referenceExternalTransactionId) {
      throw new InvalidInputError(`${props.kind} must not carry a reference`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Internal OPENING credit, created together with the wallet. It is never
   * submitted by a provider; providerId is a synthetic internal marker.
   */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      'internal',
      props.id,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      'internal-opening',
      'internal-opening',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Rebuild from persistence — no transition re-validation. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  // ---- transitions --------------------------------------------------------

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance: Money,
  ): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
  }

  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this._status, WagerTransactionStatus.PendingReference);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, observedBalance: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- domain queries -----------------------------------------------------

  isTerminal(): boolean {
    return isTerminalStatus(this._status);
  }

  /** LOSS records a result but never moves the balance; everything else does. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REFERENCE_REQUIRED_KINDS.includes(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * The ledger direction this transaction applies. ROLLBACK inverts the
   * direction of its reference; LOSS has no direction (it produces no entry).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidInputError('ROLLBACK requires a resolved reference to invert');
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Credit ? LedgerDirection.Debit : LedgerDirection.Credit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidInputError('LOSS has no ledger direction');
      default:
        throw new InvalidInputError(`unknown kind: ${this.kind}`);
    }
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, to);
    }
  }
}
