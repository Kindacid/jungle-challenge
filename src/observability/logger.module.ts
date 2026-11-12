import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule, type Params } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config.ts';

/**
 * Structured JSON logging via pino. Every HTTP log line carries a correlationId
 * (reused from the x-correlation-id header or minted per request). Sensitive
 * headers and request bodies are redacted — no credentials or full financial
 * payloads reach the logs.
 */
export const AppLoggerModule = LoggerModule.forRootAsync({
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): Params => {
    const pinoHttp = {
      level: config.logLevel,
      // Correlation id: honor an inbound one, otherwise mint and echo it back.
      genReqId: (req: IncomingMessage, res: ServerResponse): string => {
        const header = req.headers['x-correlation-id'];
        const id = (Array.isArray(header) ? header[0] : header) ?? randomUUID();
        res.setHeader('x-correlation-id', id);
        return id;
      },
      customProps: (req: IncomingMessage & { id?: string }) => ({
        correlationId: req.id,
        instanceId: config.instanceId,
        role: config.role,
      }),
      // Never log secrets or full financial payloads.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["idempotency-key"]',
          'req.body',
        ],
        remove: true,
      },
      autoLogging: true,
    };
    // pino-http's option typings are stricter than the runtime contract; the
    // shape above is validated by the DI smoke check. Narrow once here.
    return { pinoHttp } as unknown as Params;
  },
});
