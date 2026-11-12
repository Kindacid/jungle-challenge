/*
 * Distributed Wagering Processor — Jungle Gaming technical challenge.
 * Copyright (c) 2026 [SEU NOME COMPLETO]. Proprietary, evaluation-only. See LICENSE.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module.ts';
import { loadConfig } from './config/app-config.ts';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  // Buffer early logs until the pino logger is wired, then route all Nest logs
  // (including the workers') through structured JSON logging.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  // Graceful shutdown: workers listen for these to drain in-flight work.
  app.enableShutdownHooks();

  await app.listen(config.httpPort, '0.0.0.0');
  new Logger('bootstrap').log(
    `wagering service up on :${config.httpPort} — role=${config.role} instance=${config.instanceId}`,
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal: failed to bootstrap', err);
  process.exit(1);
});
