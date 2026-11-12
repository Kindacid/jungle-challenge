import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import {
  type WalletLedgerEntryRecord,
  type WalletRecord,
  walletLedgerEntrySchema,
  walletSchema,
} from '../../../database/records.ts';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import type { Wallet } from '../../domain/wallet.ts';
import {
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  walletToDomain,
  walletToRecord,
} from './wallet.mappers.ts';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

export interface ReconciliationTotals {
  calculatedBalance: string; // decimal string
  checkedEntries: number;
  /** Highest wallet_version present in the ledger (chain head). */
  maxVersion: number;
}

/**
 * Data access for wallets and their ledger. All methods take the transactional
 * EntityManager so they run inside the caller's unit of work. Writes use
 * immediate statements (insert/nativeUpdate) so ordering is explicit and
 * foreign keys are satisfied as rows are written.
 */
export class WalletRepository {
  /** Lock the wallet row FOR UPDATE — the per-wallet concurrency boundary. */
  async findForUpdate(em: EntityManager, id: string): Promise<Wallet | null> {
    const rec = await em.findOne<WalletRecord>(
      walletSchema,
      { id },
      {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      },
    );
    return rec ? walletToDomain(rec) : null;
  }

  async findById(em: EntityManager, id: string): Promise<Wallet | null> {
    const rec = await em.findOne<WalletRecord>(walletSchema, { id });
    return rec ? walletToDomain(rec) : null;
  }

  async insert(em: EntityManager, wallet: Wallet): Promise<void> {
    await em.insert<WalletRecord>(walletSchema, walletToRecord(wallet));
  }

  /** Persist a balance change (version/balance/updatedAt) for a locked wallet. */
  async applyBalance(em: EntityManager, wallet: Wallet): Promise<void> {
    await em.nativeUpdate<WalletRecord>(
      walletSchema,
      { id: wallet.id },
      {
        balanceAmount: wallet.balance.toString(),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
  }

  async insertLedgerEntry(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await em.insert<WalletLedgerEntryRecord>(walletLedgerEntrySchema, ledgerEntryToRecord(entry));
  }

  /** Keyset page over the ledger, newest first, keyed on wallet_version. */
  async listLedger(
    em: EntityManager,
    walletId: string,
    limit: number,
    cursorVersion: number | null,
  ): Promise<LedgerPage> {
    const where: Record<string, unknown> = { walletId };
    if (cursorVersion !== null) {
      where.walletVersion = { $lt: cursorVersion };
    }
    const rows = await em.find<WalletLedgerEntryRecord>(walletLedgerEntrySchema, where, {
      orderBy: { walletVersion: 'desc' },
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && page.length > 0 ? String(page[page.length - 1]?.walletVersion) : null;
    return { entries: page.map(ledgerEntryToDomain), nextCursor };
  }

  /** Recompute the balance from the ledger for reconciliation. */
  async reconcile(em: EntityManager, walletId: string): Promise<ReconciliationTotals> {
    const rows = await em.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS calculated,
         COUNT(*)::int AS cnt,
         COALESCE(MAX(wallet_version), 0)::int AS max_version
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId],
    );
    const row = (rows as Array<{ calculated: string; cnt: number; max_version: number }>)[0];
    return {
      calculatedBalance: row?.calculated ?? '0',
      checkedEntries: row?.cnt ?? 0,
      maxVersion: row?.max_version ?? 0,
    };
  }
}
