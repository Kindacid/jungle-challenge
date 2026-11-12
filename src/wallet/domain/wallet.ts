import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidInputError,
} from '../../shared/domain/domain-error.ts';
import { Money } from '../../shared/domain/money.ts';
import { LedgerDirection } from './ledger-direction.ts';
import { WalletLedgerEntry } from './wallet-ledger-entry.ts';

/** Context the application supplies when applying a balance movement. */
export interface MovementContext {
  /** The wager transaction that causes this movement. */
  transactionId: string;
  /** Pre-generated id for the ledger entry (ids come from the IdGenerator port). */
  ledgerEntryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  currency: string;
  initialBalance: Money;
  /** Required only when initialBalance > 0, to build the OPENING ledger entry. */
  openingTransactionId?: string;
  openingEntryId?: string;
  now: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Wallet aggregate root. Owns the balance invariants: one wallet per
 * (playerId, currency), balance never negative, every balance change paired with
 * exactly one ledger entry, and a monotonically increasing `version` that bumps
 * only when the balance changes (optimistic-lock token).
 *
 * The aggregate enforces these in memory; the same guarantees are also enforced
 * in the schema (CHECK/trigger/version guard), which is the real line of defense
 * under concurrency.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Open a wallet. It is born at version 1 already holding `initialBalance`; when
   * that balance is positive, an OPENING ledger entry at version 1 is produced in
   * the same unit of work (returned to the caller to persist atomically).
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (props.initialBalance.currency !== props.currency) {
      throw new CurrencyMismatchError(props.currency, props.initialBalance.currency);
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidInputError('initial balance cannot be negative');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );

    if (props.initialBalance.isPositive()) {
      if (!props.openingTransactionId || !props.openingEntryId) {
        throw new InvalidInputError(
          'openingTransactionId and openingEntryId are required for a positive initial balance',
        );
      }
      const openingEntry = WalletLedgerEntry.create({
        id: props.openingEntryId,
        walletId: wallet.id,
        transactionId: props.openingTransactionId,
        direction: LedgerDirection.Credit,
        money: props.initialBalance,
        balanceBefore: Money.zero(props.currency),
        balanceAfter: props.initialBalance,
        walletVersion: 1,
        createdAt: props.now,
      });
      return { wallet, openingEntry };
    }

    return { wallet };
  }

  /** Reconstruct from persistence — does not re-validate transition rules. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** True iff a debit of `amount` keeps the balance at or above zero. */
  hasSufficientBalance(amount: Money): boolean {
    this.assertSameCurrency(amount);
    return !this._balance.isLessThan(amount);
  }

  /**
   * Apply a credit: balance increases, version bumps, and a CREDIT ledger entry
   * at the new version is returned. Balance and entry stay consistent by
   * construction.
   */
  credit(amount: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvalidInputError('credit amount must be strictly positive');
    }
    const before = this._balance;
    const after = before.add(amount);
    return this.applyMovement(LedgerDirection.Credit, amount, before, after, ctx);
  }

  /**
   * Apply a debit: rejects (throws) if it would overdraw, otherwise balance
   * decreases, version bumps, and a DEBIT ledger entry at the new version is
   * returned.
   */
  debit(amount: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvalidInputError('debit amount must be strictly positive');
    }
    if (!this.hasSufficientBalance(amount)) {
      throw new InsufficientFundsError();
    }
    const before = this._balance;
    const after = before.subtract(amount);
    return this.applyMovement(LedgerDirection.Debit, amount, before, after, ctx);
  }

  private applyMovement(
    direction: LedgerDirection,
    amount: Money,
    before: Money,
    after: Money,
    ctx: MovementContext,
  ): WalletLedgerEntry {
    this._version += 1;
    this._balance = after;
    this._updatedAt = ctx.at;
    return WalletLedgerEntry.create({
      id: ctx.ledgerEntryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money: amount,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version,
      createdAt: ctx.at,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
