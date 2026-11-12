import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { classifyPgError, isTransient } from '../database/pg-error.ts';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  NotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../shared/application/application-errors.ts';
import { DomainError, InvalidInputError } from '../shared/domain/domain-error.ts';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  retryable: boolean;
  correlationId?: string;
}

/**
 * Maps every thrown error to a single, consistent `application/problem+json`
 * body. The mapping lets a provider decide — from the `status` + `code` +
 * `retryable` tri:
 *   400 invalid payload · 409 idempotency/duplicate conflict · 404 not found ·
 *   422 business rejection · 503 transient infra (with Retry-After) · 500 unknown.
 * Business REJECTIONS are NOT exceptions — they return 422 from the controller
 * with a normal body; this filter only handles the error cases.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { correlationId?: string }>();

    const problem = this.toProblem(exception);
    problem.correlationId = req.correlationId;

    if (problem.status >= 500) {
      this.logger.error(`${problem.code}: ${problem.detail}`, errorStack(exception));
    }
    if (problem.status === 503) {
      res.setHeader('Retry-After', '1');
    }

    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): ProblemDetails {
    const make = (
      status: number,
      code: string,
      detail: string,
      retryable: boolean,
    ): ProblemDetails => ({
      type: 'about:blank',
      title: code,
      status,
      code,
      detail,
      retryable,
    });

    if (exception instanceof InvalidPayloadError)
      return make(400, exception.code, exception.message, false);
    if (exception instanceof IdempotencyConflictError)
      return make(409, exception.code, exception.message, false);
    if (exception instanceof WalletAlreadyExistsError)
      return make(409, exception.code, exception.message, false);
    if (exception instanceof WalletNotFoundError)
      return make(404, exception.code, exception.message, false);
    if (exception instanceof NotFoundError)
      return make(404, exception.code, exception.message, false);
    if (exception instanceof TransientInfrastructureError)
      return make(503, exception.code, exception.message, true);

    if (exception instanceof InvalidInputError)
      return make(400, exception.code, exception.message, false);
    if (exception instanceof DomainError)
      return make(422, exception.code, exception.message, false);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const detail =
        typeof response === 'string'
          ? response
          : JSON.stringify((response as { message?: unknown }).message ?? response);
      const code = status === 400 ? 'INVALID_PAYLOAD' : httpCode(status);
      return make(status, code, detail, status === 503);
    }

    // Unwrapped infrastructure error: retry if transient, else internal.
    const kind = classifyPgError(exception);
    if (isTransient(kind)) {
      return make(503, 'TRANSIENT_INFRASTRUCTURE', `transient database error (${kind})`, true);
    }
    return make(500, 'INTERNAL_ERROR', 'unexpected server error', false);
  }
}

function httpCode(status: number): string {
  switch (status) {
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'HTTP_ERROR';
  }
}

function errorStack(exception: unknown): string | undefined {
  return exception instanceof Error ? exception.stack : String(exception);
}
