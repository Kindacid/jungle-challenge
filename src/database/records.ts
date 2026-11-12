import { EntitySchema } from '@mikro-orm/core';

/**
 * Persistence records. These are plain row shapes mapped by MikroORM — they are
 * deliberately separate from the domain classes so the domain stays free of ORM
 * concerns. Mappers translate between the two (see each module's mapper). Money
 * is stored as decimal columns and surfaced as strings (MikroORM `decimal`),
 * which feed straight into `Money.from` with no float ever involved.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const walletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balanceAmount: { type: 'decimal', precision: 20, scale: 2, fieldName: 'balance_amount' },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    updatedAt: { type: 'datetime', fieldName: 'updated_at' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  observedBalanceAmount!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  correlationId!: string | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const wagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', length: 64, fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', nullable: true, fieldName: 'round_id' },
    gameId: { type: 'string', nullable: true, fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: {
      type: 'string',
      nullable: true,
      fieldName: 'reference_external_transaction_id',
    },
    referenceTransactionId: {
      type: 'uuid',
      nullable: true,
      fieldName: 'reference_transaction_id',
    },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true, fieldName: 'failure_code' },
    observedBalanceAmount: {
      type: 'decimal',
      precision: 20,
      scale: 2,
      nullable: true,
      fieldName: 'observed_balance_amount',
    },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextReferenceAttemptAt: {
      type: 'datetime',
      nullable: true,
      fieldName: 'next_reference_attempt_at',
    },
    correlationId: { type: 'string', nullable: true, fieldName: 'correlation_id' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
    processedAt: { type: 'datetime', nullable: true, fieldName: 'processed_at' },
  },
});

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  currency!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const walletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    currency: { type: 'string', length: 3 },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2 },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2, fieldName: 'balance_before' },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2, fieldName: 'balance_after' },
    walletVersion: { type: 'integer', fieldName: 'wallet_version' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
  transactionId!: string | null;
}

export const inboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true, fieldName: 'consumer_name' },
    messageId: { type: 'string', primary: true, fieldName: 'message_id' },
    payloadHash: { type: 'string', length: 64, fieldName: 'payload_hash' },
    receivedAt: { type: 'datetime', fieldName: 'received_at' },
    processedAt: { type: 'datetime', nullable: true, fieldName: 'processed_at' },
    transactionId: { type: 'uuid', nullable: true, fieldName: 'transaction_id' },
  },
});

export class OutboxMessageRecord {
  id!: string;
  sequence!: string;
  aggregateId!: string;
  eventType!: string;
  eventVersion!: number;
  payload!: Record<string, unknown>;
  correlationId!: string | null;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  lockedUntil!: Date | null;
  lockedBy!: string | null;
  publishedAt!: Date | null;
  lastError!: string | null;
  createdAt!: Date;
}

export const outboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    // IDENTITY column; never written by the app.
    sequence: { type: 'bigint', fieldName: 'sequence' },
    aggregateId: { type: 'string', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    eventVersion: { type: 'integer', fieldName: 'event_version' },
    payload: { type: 'json' },
    correlationId: { type: 'string', nullable: true, fieldName: 'correlation_id' },
    occurredAt: { type: 'datetime', fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', nullable: true, fieldName: 'next_attempt_at' },
    lockedUntil: { type: 'datetime', nullable: true, fieldName: 'locked_until' },
    lockedBy: { type: 'string', nullable: true, fieldName: 'locked_by' },
    publishedAt: { type: 'datetime', nullable: true, fieldName: 'published_at' },
    lastError: { type: 'string', nullable: true, fieldName: 'last_error' },
    createdAt: { type: 'datetime', fieldName: 'created_at' },
  },
});

export const ALL_SCHEMAS = [
  walletSchema,
  wagerTransactionSchema,
  walletLedgerEntrySchema,
  inboxMessageSchema,
  outboxMessageSchema,
];
