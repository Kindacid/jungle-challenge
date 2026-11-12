import { Module } from '@nestjs/common';
import { WagerTransactionRepository } from './infrastructure/persistence/wager-transaction.repository.ts';

/**
 * The wager-transaction repository in isolation, so the wallet module can persist
 * the internal OPENING transaction without importing the full wagering module
 * (which would create a cycle: wagering already imports wallet).
 */
@Module({
  providers: [WagerTransactionRepository],
  exports: [WagerTransactionRepository],
})
export class WageringPersistenceModule {}
