import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

/** Reuse an incoming correlation id, or mint one. Also exposed for logging. */
export function correlationIdOf(req: Request & { correlationId?: string }): string {
  if (req.correlationId) return req.correlationId;
  const header = req.headers['x-correlation-id'];
  const id = (Array.isArray(header) ? header[0] : header) ?? randomUUID();
  req.correlationId = id;
  return id;
}
