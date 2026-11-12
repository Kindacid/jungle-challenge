import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { loadConfig } from './config/app-config.ts';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger('bootstrap');

  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Graceful shutdown: workers listen for these to drain in-flight work.
  app.enableShutdownHooks();

  await app.listen(config.httpPort, '0.0.0.0');
  logger.log(
    `wagering service up on :${config.httpPort} — role=${config.role} instance=${config.instanceId}`,
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal: failed to bootstrap', err);
  process.exit(1);
});
