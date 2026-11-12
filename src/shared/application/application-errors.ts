/**
 * Application-level errors that the transport layer (HTTP / SQS consumer) maps to
 * precise responses. They are distinct from domain errors (invariant violations)
 * and from business rejections (which are a normal, PROCESSED-or-REJECTED
 * outcome, not an exception).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The request body / message failed validation before any processing. */
export class InvalidPayloadError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
}

/** Idempotency-Key reused with a different payload hash — a conflict, not a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** A referenced wallet does not exist. */
export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
}

/** A duplicate wallet for (playerId, currency). */
export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

/** A requested entity was not found (generic 404). */
export class NotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';
}

/**
 * A transient infrastructure failure (DB/SQS unavailable, lock timeout, retries
 * exhausted). The caller may retry later.
 */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE';
}
