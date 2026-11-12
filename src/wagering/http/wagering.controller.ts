import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { correlationIdOf } from '../../http/correlation.util.ts';
import { InvalidPayloadError } from '../../shared/application/application-errors.ts';
import { Money } from '../../shared/domain/money.ts';
import { GetTransactionUseCase } from '../application/get-transaction.use-case.ts';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case.ts';
import { WagerTransactionStatus } from '../domain/wager-transaction-status.ts';
import { SubmitWagerDto } from './submit-wager.dto.ts';
import { presentTransaction } from './transaction.presenter.ts';

function httpStatusForOutcome(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    default:
      return 200;
  }
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
  ) {}

  @Post()
  async submitTransaction(
    @Body() dto: SubmitWagerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new InvalidPayloadError('Idempotency-Key header is required');
    }

    const result = await this.submit.execute({
      idempotencyKey,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: Money.from(dto.money),
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      correlationId: correlationIdOf(req),
    });

    res.status(httpStatusForOutcome(result.status));
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance.toJSON(),
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get(':transactionId')
  async getById(@Param('transactionId', new ParseUUIDPipe()) transactionId: string) {
    return presentTransaction(await this.getTransaction.byId(transactionId));
  }
}
