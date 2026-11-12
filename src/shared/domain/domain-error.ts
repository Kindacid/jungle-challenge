/**
 * Base class for all domain errors. A domain error represents a violation of a
 * business rule or an invariant — never an infrastructure failure. Each error
 * carries a stable, machine-readable `code` so the transport layer (HTTP, SQS)
 * can map it without parsing messages.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain when targeting ES5-ish runtimes.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The caller tried to build a value object / entity from invalid input. */
export class InvalidInputError extends DomainError {
  readonly code = 'INVALID_INPUT';
}

/** Arithmetic or comparison attempted across two different currencies. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * A debit would drive the balance below zero. This is a generic domain signal;
 * the application layer maps it to a specific business FailureCode (a player bet
 * without funds vs. a reversal that would overdraw are operationally different).
 */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor() {
    super('insufficient funds for debit');
  }
}

/** A transition was requested on an entity already in a terminal state. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(from: string, to: string) {
    super(`invalid transaction state transition: ${from} -> ${to}`);
  }
}
