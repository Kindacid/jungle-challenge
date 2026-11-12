/**
 * Classifies PostgreSQL / driver errors by SQLSTATE so the application can decide
 * whether to retry (transient), surface a conflict, or treat it as a permanent
 * failure. MikroORM wraps driver errors, so we dig for the underlying code.
 */

export type PgErrorKind =
  | 'serialization' // 40001
  | 'deadlock' // 40P01
  | 'lock_timeout' // 55P03
  | 'statement_timeout' // 57014
  | 'unique_violation' // 23505
  | 'check_violation' // 23514
  | 'not_null_violation' // 23502
  | 'foreign_key_violation' // 23503
  | 'connection' // 08xxx / 57P01 / ECONNREFUSED
  | 'too_many_connections' // 53300
  | 'trigger_raise' // P0001 (our plpgsql RAISE EXCEPTION)
  | 'unknown';

const BY_CODE: Record<string, PgErrorKind> = {
  '40001': 'serialization',
  '40P01': 'deadlock',
  '55P03': 'lock_timeout',
  '57014': 'statement_timeout',
  '23505': 'unique_violation',
  '23514': 'check_violation',
  '23502': 'not_null_violation',
  '23503': 'foreign_key_violation',
  '53300': 'too_many_connections',
  P0001: 'trigger_raise',
};

/** Extract a Postgres SQLSTATE from a possibly-wrapped error. */
export function getSqlState(error: unknown): string | undefined {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && e && typeof e === 'object'; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    // Common connection-error codes from Node/undici.
    if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
      return code;
    }
    e = (e as { cause?: unknown; previous?: unknown }).cause ?? (e as { previous?: unknown }).previous;
  }
  return undefined;
}

export function classifyPgError(error: unknown): PgErrorKind {
  const code = getSqlState(error);
  if (!code) return 'unknown';
  if (BY_CODE[code]) return BY_CODE[code];
  if (code.startsWith('08') || code === '57P01' || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
    return 'connection';
  }
  return 'unknown';
}

/** Transient errors are safe to retry after a short backoff. */
export function isTransient(kind: PgErrorKind): boolean {
  return (
    kind === 'serialization' ||
    kind === 'deadlock' ||
    kind === 'lock_timeout' ||
    kind === 'statement_timeout' ||
    kind === 'connection' ||
    kind === 'too_many_connections'
  );
}

export function isUniqueViolation(error: unknown): boolean {
  return classifyPgError(error) === 'unique_violation';
}

/** The constraint name carried by a unique/check violation, if present. */
export function getConstraintName(error: unknown): string | undefined {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && e && typeof e === 'object'; depth++) {
    const c = (e as { constraint?: unknown }).constraint;
    if (typeof c === 'string') return c;
    e = (e as { cause?: unknown; previous?: unknown }).cause ?? (e as { previous?: unknown }).previous;
  }
  return undefined;
}
