import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys are sorted recursively, there is
 * no insignificant whitespace, and `undefined` properties are omitted. Two
 * payloads that are semantically equal always produce byte-identical output, so
 * their hashes match regardless of key order on the wire.
 *
 * Rules:
 * - objects → keys sorted lexicographically, undefined values dropped;
 * - arrays  → order preserved (order is significant);
 * - numbers → rejected via a guard upstream for money; here we still serialize
 *   them with JSON semantics, but monetary values are always strings by contract;
 * - null    → emitted as null.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error('cannot canonicalize non-finite number');
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean') return (value as boolean) ? 'true' : 'false';
  if (t === 'bigint') return (value as bigint).toString();

  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item === undefined ? null : item)).join(',')}]`;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`);
    return `{${entries.join(',')}}`;
  }

  throw new Error(`cannot canonicalize value of type ${t}`);
}

/** SHA-256 (hex) of the canonical JSON of `value`. Stable across key orderings. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
