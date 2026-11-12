import { Controller, Get, Param } from '@nestjs/common';
import { GetTransactionUseCase } from '../application/get-transaction.use-case.ts';
import { presentTransaction } from './transaction.presenter.ts';

@Controller('providers')
export class ProviderTransactionsController {
  constructor(private readonly getTransaction: GetTransactionUseCase) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async getByProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return presentTransaction(
      await this.getTransaction.byProviderExternalId(providerId, externalTransactionId),
    );
  }
}
