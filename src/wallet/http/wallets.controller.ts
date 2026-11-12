import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { correlationIdOf } from '../../http/correlation.util.ts';
import { Money } from '../../shared/domain/money.ts';
import { CreateWalletUseCase } from '../application/create-wallet.use-case.ts';
import { GetWalletUseCase } from '../application/get-wallet.use-case.ts';
import { ListWalletLedgerUseCase } from '../application/list-wallet-ledger.use-case.ts';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case.ts';
import { CreateWalletDto } from './create-wallet.dto.ts';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListWalletLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateWalletDto, @Req() req: Request) {
    const result = await this.createWallet.execute({
      playerId: dto.playerId,
      initialBalance: Money.from(dto.initialBalance),
      correlationId: correlationIdOf(req),
    });
    return {
      id: result.id,
      playerId: result.playerId,
      balance: result.balance.toJSON(),
      version: result.version,
    };
  }

  @Get(':walletId')
  async get(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    const wallet = await this.getWallet.execute(walletId);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const page = await this.listLedger.execute({
      walletId,
      limit: limit ? Number.parseInt(limit, 10) : 50,
      cursor,
    });
    return {
      entries: page.entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        walletVersion: e.walletVersion,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.reconcile.execute(walletId);
  }
}
