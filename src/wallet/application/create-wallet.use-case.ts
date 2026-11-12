import { Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../../database/pg-error.ts';
import { TransactionRunner } from '../../database/transaction-runner.ts';
import { WalletBalanceChanged } from '../../messaging/events/wagering-events.ts';
import { OutboxRepository } from '../../messaging/infrastructure/outbox.repository.ts';
import { OutboxMessage } from '../../messaging/outbox/outbox-message.ts';
import { WalletAlreadyExistsError } from '../../shared/application/application-errors.ts';
import { canonicalHash } from '../../shared/domain/canonical-json.ts';
import { Clock } from '../../shared/domain/clock.ts';
import { IdGenerator } from '../../shared/domain/id-generator.ts';
import type { Money } from '../../shared/domain/money.ts';
import { WagerTransaction } from '../../wagering/domain/wager-transaction.ts';
import { WagerTransactionRepository } from '../../wagering/infrastructure/persistence/wager-transaction.repository.ts';
import { Wallet } from '../domain/wallet.ts';
import { WalletRepository } from '../infrastructure/persistence/wallet.repository.ts';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
}

/**
 * Opens a wallet. When the initial balance is positive, an internal OPENING
 * transaction and its CREDIT ledger entry are written in the SAME SQL
 * transaction, so the wallet is never seen with a balance that has no ledger
 * backing. Duplicate (playerId, currency) surfaces as a conflict.
 */
@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly txRunner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    try {
      return await this.txRunner.run(async (em) => {
        const now = this.clock.now();
        const currency = command.initialBalance.currency;
        const walletId = this.ids.next();
        const openingTxId = this.ids.next();
        const openingEntryId = this.ids.next();

        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          currency,
          initialBalance: command.initialBalance,
          openingTransactionId: openingTxId,
          openingEntryId,
          now,
        });

        await this.wallets.insert(em, wallet);

        if (openingEntry) {
          const openingTx = WagerTransaction.opening({
            id: openingTxId,
            walletId,
            playerId: command.playerId,
            currency,
            money: command.initialBalance,
            idempotencyKey: `opening:${walletId}`,
            payloadHash: canonicalHash({
              kind: 'OPENING',
              walletId,
              amount: command.initialBalance.toString(),
            }),
            createdAt: now,
          });
          openingTx.markProcessed(undefined, now, wallet.balance);
          await this.transactions.insert(em, openingTx, { correlationId: command.correlationId });
          await this.wallets.insertLedgerEntry(em, openingEntry);

          const event = WalletBalanceChanged.from(wallet, openingEntry, {
            eventId: this.ids.next(),
            correlationId: command.correlationId,
            causationId: openingTx.id,
            occurredAt: now,
          });
          await this.outbox.insertMany(em, [OutboxMessage.enqueue(event)]);
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance,
          version: wallet.version,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new WalletAlreadyExistsError(
          `a wallet already exists for player ${command.playerId} / ${command.initialBalance.currency}`,
        );
      }
      throw err;
    }
  }
}
