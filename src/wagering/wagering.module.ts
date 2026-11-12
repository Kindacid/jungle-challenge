import { Module } from '@nestjs/common';
import { MessagingPersistenceModule } from '../messaging/messaging-persistence.module.ts';
import { WalletModule } from '../wallet/wallet.module.ts';
import { GetTransactionUseCase } from './application/get-transaction.use-case.ts';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case.ts';
import { WagerProcessor } from './domain/wager-processor.ts';
import { ProviderTransactionsController } from './http/provider-transactions.controller.ts';
import { WageringController } from './http/wagering.controller.ts';
import { WageringPersistenceModule } from './wagering-persistence.module.ts';

@Module({
  imports: [WalletModule, MessagingPersistenceModule, WageringPersistenceModule],
  controllers: [WageringController, ProviderTransactionsController],
  providers: [WagerProcessor, SubmitWagerTransactionUseCase, GetTransactionUseCase],
  exports: [SubmitWagerTransactionUseCase, WagerProcessor],
})
export class WageringModule {}
