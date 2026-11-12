import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';

/**
 * The final invariant of every integration/concurrency test:
 *   wallet.balance == balance reconstructed from the ledger.
 * Also checks the wallet version equals the ledger chain head.
 */
export async function assertLedgerInvariant(orm: MikroORM, walletId: string): Promise<void> {
  const em = orm.em.fork();
  const walletRows = (await em.execute(
    'SELECT balance_amount::text AS balance, version FROM wallets WHERE id = ?',
    [walletId],
  )) as Array<{ balance: string; version: number }>;
  expect(walletRows.length).toBe(1);
  const wallet = walletRows[0];
  if (!wallet) return;

  const sumRows = (await em.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS sum,
       COALESCE(MAX(wallet_version), 0)::int AS max_version,
       COUNT(*)::int AS cnt
     FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  )) as Array<{ sum: string; max_version: number; cnt: number }>;
  const totals = sumRows[0];
  if (!totals) return;

  // balance == sum(ledger)
  expect(new Decimal(wallet.balance).equals(new Decimal(totals.sum))).toBe(true);

  // version matches the chain head (or version 1 for an empty, zero-opened wallet)
  if (totals.cnt === 0) {
    expect(wallet.version).toBe(1);
  } else {
    expect(wallet.version).toBe(totals.max_version);
  }
}

/** Count ledger entries for a wallet (e.g. assert exactly one debit). */
export async function countLedgerEntries(
  orm: MikroORM,
  walletId: string,
  direction?: 'DEBIT' | 'CREDIT',
): Promise<number> {
  const em = orm.em.fork();
  const where = direction ? 'AND direction = ?' : '';
  const params = direction ? [walletId, direction] : [walletId];
  const rows = (await em.execute(
    `SELECT COUNT(*)::int AS cnt FROM wallet_ledger_entries WHERE wallet_id = ? ${where}`,
    params,
  )) as Array<{ cnt: number }>;
  return rows[0]?.cnt ?? 0;
}
