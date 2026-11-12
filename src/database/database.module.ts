import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.ts';
import { createOrmConfig } from './mikro-orm.config.ts';
import { MikroOrmTransactionRunner, TransactionRunner } from './transaction-runner.ts';

/**
 * Wires MikroORM (connection pool, request context) and the TransactionRunner.
 * Exported globally so repositories and use cases across modules share one ORM.
 */
@Global()
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createOrmConfig(config),
    }),
  ],
  providers: [
    {
      provide: TransactionRunner,
      inject: [MikroORM, APP_CONFIG],
      useFactory: (orm: MikroORM, config: AppConfig) =>
        new MikroOrmTransactionRunner(orm, config.txMaxRetries),
    },
  ],
  // MikroOrmModule.forRoot registers a GLOBAL core module, so MikroORM and
  // EntityManager are injectable everywhere without re-exporting it here.
  exports: [TransactionRunner],
})
export class DatabaseModule {}
