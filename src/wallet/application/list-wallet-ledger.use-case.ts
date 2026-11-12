import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { InvalidPayloadError, NotFoundError } from '../../shared/application/application-errors.ts';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { WalletRepository } from '../infrastructure/persistence/wallet.repository.ts';

export interface ListLedgerQuery {
  walletId: string;
  limit: number;
  cursor?: string;
}

export interface ListLedgerResult {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

const MAX_LIMIT = 200;

/** Opaque, stable cursor = base64url of the last wallet_version seen. */
function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const version = Number.parseInt(decoded, 10);
    if (!Number.isInteger(version) || version < 0) throw new Error('bad cursor');
    return version;
  } catch {
    throw new InvalidPayloadError('invalid ledger cursor');
  }
}

function encodeCursor(nextCursor: string | null): string | null {
  return nextCursor === null ? null : Buffer.from(nextCursor, 'utf8').toString('base64url');
}

@Injectable()
export class ListWalletLedgerUseCase {
  constructor(
    private readonly orm: MikroORM,
    private readonly wallets: WalletRepository,
  ) {}

  async execute(query: ListLedgerQuery): Promise<ListLedgerResult> {
    const limit = Math.min(Math.max(query.limit, 1), MAX_LIMIT);
    const cursorVersion = decodeCursor(query.cursor);

    const em = this.orm.em.fork();
    const wallet = await this.wallets.findById(em, query.walletId);
    if (!wallet) throw new NotFoundError(`wallet ${query.walletId} not found`);

    const page = await this.wallets.listLedger(em, query.walletId, limit, cursorVersion);
    return { entries: page.entries, nextCursor: encodeCursor(page.nextCursor) };
  }
}
