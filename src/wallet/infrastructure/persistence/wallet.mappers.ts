import type { WalletLedgerEntryRecord, WalletRecord } from '../../../database/records.ts';
import { Money } from '../../../shared/domain/money.ts';
import type { LedgerDirection } from '../../domain/ledger-direction.ts';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import { Wallet } from '../../domain/wallet.ts';

export function walletToDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.from({ amount: r.balanceAmount, currency: r.currency }),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balanceAmount: w.balance.toString(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function ledgerEntryToDomain(r: WalletLedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    balanceBefore: Money.from({ amount: r.balanceBefore, currency: r.currency }),
    balanceAfter: Money.from({ amount: r.balanceAfter, currency: r.currency }),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): WalletLedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    currency: e.money.currency,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.toString(),
    balanceBefore: e.balanceBefore.toString(),
    balanceAfter: e.balanceAfter.toString(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt,
  };
}
