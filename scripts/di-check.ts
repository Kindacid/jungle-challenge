/**
 * Boots the full Nest DI graph WITHOUT connecting to Postgres or SQS, to verify
 * the wiring (providers, tokens, decorator metadata) resolves. Not a substitute
 * for integration tests — it only validates dependency injection.
 *
 *   bun scripts/di-check.ts
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.ts';

function seedEnv(): void {
  process.env.ORM_SKIP_CONNECT = 'true';
  process.env.APP_ROLE = process.env.APP_ROLE ?? 'api';
  process.env.WAGER_QUEUE_URL = process.env.WAGER_QUEUE_URL ?? 'http://localhost:4566/q/main.fifo';
  process.env.WAGER_DLQ_URL = process.env.WAGER_DLQ_URL ?? 'http://localhost:4566/q/dlq.fifo';
  process.env.EVENTS_QUEUE_URL =
    process.env.EVENTS_QUEUE_URL ?? 'http://localhost:4566/q/events.fifo';
}

async function main(): Promise<void> {
  seedEnv();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  await app.init();
  console.log('DI OK: Nest application graph resolved without a database connection');
  await app.close();
}

main().catch((err) => {
  console.error('DI CHECK FAILED:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
