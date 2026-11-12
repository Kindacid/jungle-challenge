import { Module } from '@nestjs/common';
import { MessagingPersistenceModule } from '../messaging/messaging-persistence.module.ts';
import { WageringPersistenceModule } from '../wagering/wagering-persistence.module.ts';
import { CreateWalletUseCase } from './application/create-wallet.use-case.ts';
import { GetWalletUseCase } from './application/get-wallet.use-case.ts';
import { ListWalletLedgerUseCase } from './application/list-wallet-ledger.use-case.ts';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case.ts';
import { WalletsController } from './http/wallets.controller.ts';
import { WalletRepository } from './infrastructure/persistence/wallet.repository.ts';

@Module({
  imports: [WageringPersistenceModule, MessagingPersistenceModule],
  controllers: [WalletsController],
  providers: [
    WalletRepository,
    CreateWalletUseCase,
    GetWalletUseCase,
    ListWalletLedgerUseCase,
    ReconcileWalletUseCase,
  ],
  exports: [WalletRepository],
})
export class WalletModule {}
