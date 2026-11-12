import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../shared/application/application-errors.ts';
import type { Wallet } from '../domain/wallet.ts';
import { WalletRepository } from '../infrastructure/persistence/wallet.repository.ts';

@Injectable()
export class GetWalletUseCase {
  constructor(
    private readonly orm: MikroORM,
    private readonly wallets: WalletRepository,
  ) {}

  async execute(walletId: string): Promise<Wallet> {
    const em = this.orm.em.fork();
    const wallet = await this.wallets.findById(em, walletId);
    if (!wallet) throw new NotFoundError(`wallet ${walletId} not found`);
    return wallet;
  }
}
