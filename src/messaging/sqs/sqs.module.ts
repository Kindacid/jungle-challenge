import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.ts';
import { SqsGateway } from './sqs-client.ts';

/** Provides a single SQS gateway, configured from the environment. */
@Global()
@Module({
  providers: [
    {
      provide: SqsGateway,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new SqsGateway(config.sqs),
    },
  ],
  exports: [SqsGateway],
})
export class SqsModule {}
