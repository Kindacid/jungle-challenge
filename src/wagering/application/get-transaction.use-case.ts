import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../shared/application/application-errors.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository.ts';

@Injectable()
export class GetTransactionUseCase {
  constructor(
    private readonly orm: MikroORM,
    private readonly transactions: WagerTransactionRepository,
  ) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const em = this.orm.em.fork();
    const tx = await this.transactions.findById(em, transactionId);
    if (!tx) throw new NotFoundError(`transaction ${transactionId} not found`);
    return tx;
  }

  async byProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const em = this.orm.em.fork();
    const tx = await this.transactions.findByProviderExternalId(
      em,
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw new NotFoundError(`transaction ${providerId}/${externalTransactionId} not found`);
    }
    return tx;
  }
}
