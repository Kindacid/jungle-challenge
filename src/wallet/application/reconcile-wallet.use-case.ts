import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { MetricsPort } from '../../observability/metrics-port.ts';
import { NotFoundError } from '../../shared/application/application-errors.ts';
import { MONEY_SCALE, type MoneyProps } from '../../shared/domain/money.ts';
import { WalletRepository } from '../infrastructure/persistence/wallet.repository.ts';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Recomputes the balance from the immutable ledger and compares it with the
 * materialized wallet balance. Divergences are NEVER auto-corrected — they are
 * logged, counted in a metric, and flagged in the response.
 */
@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly wallets: WalletRepository,
    private readonly metrics: MetricsPort,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const em = this.orm.em.fork();
    const wallet = await this.wallets.findById(em, walletId);
    if (!wallet) throw new NotFoundError(`wallet ${walletId} not found`);

    const totals = await this.wallets.reconcile(em, walletId);
    const currency = wallet.currency;

    // Compare with raw Decimal (not Money) so a corrupt/negative ledger sum —
    // exactly what reconciliation exists to detect — is reported, not thrown on.
    const stored = new Decimal(wallet.balance.toString());
    const calculated = new Decimal(totals.calculatedBalance);
    const difference = stored.minus(calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.incReconciliationDivergence();
      this.logger.error(
        `reconciliation divergence for wallet ${walletId}: stored=${stored.toFixed(MONEY_SCALE)} ` +
          `calculated=${calculated.toFixed(MONEY_SCALE)} difference=${difference.toFixed(MONEY_SCALE)} ` +
          `entries=${totals.checkedEntries}`,
      );
    }

    return {
      walletId,
      storedBalance: { amount: stored.toFixed(MONEY_SCALE), currency },
      calculatedBalance: { amount: calculated.toFixed(MONEY_SCALE), currency },
      difference: { amount: difference.toFixed(MONEY_SCALE), currency },
      consistent,
      checkedEntries: totals.checkedEntries,
    };
  }
}
