import { IsolationLevel, type EntityManager, type MikroORM } from '@mikro-orm/postgresql';
import { classifyPgError, isTransient, type PgErrorKind } from './pg-error.ts';

/** Work executed inside one SQL transaction; receives the transactional EM. */
export type UnitOfWork<T> = (em: EntityManager) => Promise<T>;

export interface RunOptions {
  maxRetries?: number;
  /** Called on each transient retry (for metrics/logging). */
  onRetry?: (info: { attempt: number; kind: PgErrorKind }) => void;
}

/**
 * Runs a unit of work inside a single READ COMMITTED transaction, retrying the
 * whole block on transient conflicts (serialization, deadlock, lock timeout,
 * connection blips) with bounded exponential backoff + jitter. Correctness under
 * contention comes from pessimistic row locks inside the work plus the schema
 * invariants; this retry only smooths over transient failures.
 */
export abstract class TransactionRunner {
  abstract run<T>(work: UnitOfWork<T>, opts?: RunOptions): Promise<T>;
}

export class MikroOrmTransactionRunner extends TransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly maxRetriesDefault: number,
  ) {
    super();
  }

  async run<T>(work: UnitOfWork<T>, opts: RunOptions = {}): Promise<T> {
    const maxRetries = opts.maxRetries ?? this.maxRetriesDefault;
    let attempt = 0;

    for (;;) {
      // Fork gives a clean Identity Map per attempt so a rolled-back attempt
      // never leaks managed state into the next one.
      const em = this.orm.em.fork();
      try {
        return await em.transactional((tem) => work(tem), {
          isolationLevel: IsolationLevel.READ_COMMITTED,
        });
      } catch (err) {
        const kind = classifyPgError(err);
        if (isTransient(kind) && attempt < maxRetries) {
          attempt += 1;
          opts.onRetry?.({ attempt, kind });
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(25 * 2 ** (attempt - 1), 500);
  return base + Math.floor(Math.random() * base); // full jitter
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
