import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/app-config.ts';
import { SqsGateway } from '../messaging/sqs/sqs-client.ts';

/** Liveness and readiness probes. Not authenticated (see ProviderAuthGuard). */
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, 'ok' | 'down'> = { postgres: 'down', sqs: 'down' };

    try {
      await this.orm.em.getConnection().execute('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      /* stays down */
    }
    try {
      await this.sqs.ping(this.config.sqs.wagerQueueUrl);
      checks.sqs = 'ok';
    } catch {
      /* stays down */
    }

    const ready = checks.postgres === 'ok' && checks.sqs === 'ok';
    res.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks };
  }
}
