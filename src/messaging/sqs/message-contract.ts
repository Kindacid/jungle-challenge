import { InvalidPayloadError } from '../../shared/application/application-errors.ts';
import { Money } from '../../shared/domain/money.ts';
import {
  WagerTransactionKind,
  isSubmittableKind,
} from '../../wagering/domain/wager-transaction-kind.ts';

/** The inbound SQS message envelope the consumer expects. */
export interface WagerRequestedMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

function req(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new InvalidPayloadError(`missing/invalid field: ${key}`);
  }
  return v;
}

/**
 * Parse and validate a raw SQS body into a typed message. Throws
 * InvalidPayloadError (a permanent error → DLQ) on any structural problem.
 */
export function parseWagerMessage(body: string): WagerRequestedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidPayloadError('message body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidPayloadError('message body is not an object');
  }
  const root = parsed as Record<string, unknown>;
  if (root.type !== 'WagerTransactionRequested') {
    throw new InvalidPayloadError(`unexpected message type: ${String(root.type)}`);
  }
  const messageId = req(root, 'messageId');
  const data = root.data;
  if (typeof data !== 'object' || data === null) {
    throw new InvalidPayloadError('message data is missing');
  }
  const d = data as Record<string, unknown>;
  const kind = req(d, 'kind');
  if (!isSubmittableKind(kind)) {
    throw new InvalidPayloadError(`invalid kind: ${kind}`);
  }
  const money = d.money as Record<string, unknown> | undefined;
  if (!money || typeof money !== 'object') {
    throw new InvalidPayloadError('money is missing');
  }
  // Validate money strictly now so a bad amount is a permanent (DLQ) error.
  Money.from({ amount: String(money.amount), currency: String(money.currency) });

  const ref = d.referenceExternalTransactionId;

  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: typeof root.occurredAt === 'string' ? root.occurredAt : new Date().toISOString(),
    data: {
      providerId: req(d, 'providerId'),
      externalTransactionId: req(d, 'externalTransactionId'),
      idempotencyKey: req(d, 'idempotencyKey'),
      playerId: req(d, 'playerId'),
      walletId: req(d, 'walletId'),
      roundId: req(d, 'roundId'),
      gameId: req(d, 'gameId'),
      kind: kind as WagerTransactionKind,
      money: { amount: String(money.amount), currency: String(money.currency) },
      referenceExternalTransactionId: typeof ref === 'string' && ref.length > 0 ? ref : undefined,
    },
  };
}
