import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.ts';
import { ProviderAuthGuard } from './auth/provider-auth.guard.ts';
import { ConfigModule } from './config/config.module.ts';
import { DatabaseModule } from './database/database.module.ts';
import { ProblemDetailsFilter } from './http/problem-details.filter.ts';
import { MessagingPersistenceModule } from './messaging/messaging-persistence.module.ts';
import { SqsModule } from './messaging/sqs/sqs.module.ts';
import { AppLoggerModule } from './observability/logger.module.ts';
import { ObservabilityModule } from './observability/observability.module.ts';
import { CoreModule } from './shared/core.module.ts';
import { WageringModule } from './wagering/wagering.module.ts';
import { WalletModule } from './wallet/wallet.module.ts';
import { WorkerModule } from './worker/worker.module.ts';

@Module({
  imports: [
    // Global infrastructure.
    ConfigModule,
    AppLoggerModule,
    CoreModule,
    DatabaseModule,
    SqsModule,
    ObservabilityModule,
    AuthModule,
    MessagingPersistenceModule,
    // Feature modules.
    WalletModule,
    WageringModule,
    // Background workers (SQS consumer, outbox publisher, pending-ref resolver).
    WorkerModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
  ],
})
export class AppModule {}
