import type { EntityManager } from '@mikro-orm/postgresql';
import { type InboxMessageRecord, inboxMessageSchema } from '../../database/records.ts';
import { InboxMessage } from '../inbox/inbox-message.ts';

export class InboxRepository {
  /**
   * Insert the dedup record if it does not already exist. Returns true when this
   * call inserted it (first delivery), false when it already existed (duplicate).
   * The uniqueness is enforced by the (consumer_name, message_id) primary key.
   */
  async tryInsert(em: EntityManager, msg: InboxMessage): Promise<boolean> {
    const rows = (await em.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [msg.consumerName, msg.messageId, msg.payloadHash, msg.receivedAt],
    )) as Array<{ message_id: string }>;
    return rows.length > 0;
  }

  async find(
    em: EntityManager,
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const r = await em.findOne<InboxMessageRecord>(inboxMessageSchema, { consumerName, messageId });
    if (!r) return null;
    return InboxMessage.rehydrate({
      consumerName: r.consumerName,
      messageId: r.messageId,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: r.processedAt ?? undefined,
      transactionId: r.transactionId ?? undefined,
    });
  }

  async markProcessed(
    em: EntityManager,
    consumerName: string,
    messageId: string,
    at: Date,
    transactionId: string | undefined,
  ): Promise<void> {
    await em.nativeUpdate<InboxMessageRecord>(
      inboxMessageSchema,
      { consumerName, messageId },
      { processedAt: at, transactionId: transactionId ?? null },
    );
  }
}
