import { InvalidInputError } from '../../shared/domain/domain-error.ts';
import type { Money } from '../../shared/domain/money.ts';
import { LedgerDirection } from './ledger-direction.ts';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version produced by this entry (monotonic, 1 per balance change). */
  walletVersion: number;
  createdAt: Date;
}

/** State shape used to rebuild an entry from persistence without re-validation. */
export interface LedgerEntryState extends CreateLedgerEntryProps {}

/**
 * An immutable, append-only ledger line. There are no mutable fields and no
 * transition methods — immutability is structural. `create` validates the
 * arithmetic (`balanceBefore ± money === balanceAfter`) so a malformed entry can
 * never exist in memory, mirroring the CHECK constraint in the schema.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidInputError('ledger entry amount must be strictly positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidInputError('ledger balances cannot be negative');
    }
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new InvalidInputError(
        `unbalanced ledger entry: ${props.balanceBefore.toString()} ${props.direction} ` +
          `${props.money.toString()} != ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Rebuild from persistence. Does not re-validate transition rules. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** True iff balanceBefore ± money === balanceAfter for this direction. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
