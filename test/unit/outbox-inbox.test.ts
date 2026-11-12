import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../src/messaging/inbox/inbox-message.ts';
import { OutboxMessage } from '../../src/messaging/outbox/outbox-message.ts';
import { WalletBalanceChanged } from '../../src/messaging/events/wagering-events.ts';
import { Money } from '../../src/shared/domain/money.ts';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction.ts';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry.ts';
import { Wallet } from '../../src/wallet/domain/wallet.ts';

const now = new Date('2026-01-01T00:00:00Z');
const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

describe('OutboxMessage', () => {
  function enqueueSample() {
    const { wallet } = Wallet.open({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      initialBalance: brl('100.00'),
      openingTransactionId: 't0',
      openingEntryId: 'l0',
      now,
    });
    const entry = WalletLedgerEntry.create({
      id: 'le1',
      walletId: 'w1',
      transactionId: 'tx1',
      direction: LedgerDirection.Debit,
      money: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('70.00'),
      walletVersion: 2,
      createdAt: now,
    });
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: 'evt-1',
      correlationId: 'corr-1',
      occurredAt: now,
    });
    return OutboxMessage.enqueue(event);
  }

  it('enqueues an event as a pending, due message carrying the envelope', () => {
    const msg = enqueueSample();
    expect(msg.id).toBe('evt-1');
    expect(msg.eventType).toBe('WalletBalanceChanged');
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(now)).toBe(true);
    expect((msg.payload as Record<string, unknown>).eventType).toBe('WalletBalanceChanged');
  });

  it('marks published and is no longer pending/due', () => {
    const msg = enqueueSample();
    msg.markPublished(now);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(now)).toBe(false);
    expect(msg.publishedAt).toEqual(now);
  });

  it('applies exponential backoff on retry, capped at 5 minutes', () => {
    const msg = enqueueSample();
    msg.scheduleRetry(now, 'sqs down');
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt?.getTime()).toBe(now.getTime() + 1_000);

    msg.scheduleRetry(now);
    expect(msg.nextAttemptAt?.getTime()).toBe(now.getTime() + 2_000);

    for (let i = 0; i < 20; i++) msg.scheduleRetry(now);
    expect(msg.nextAttemptAt?.getTime()).toBe(now.getTime() + 5 * 60_000);
  });
});

describe('InboxMessage', () => {
  it('starts unprocessed and can be marked processed', () => {
    const msg = InboxMessage.receive({
      messageId: 'm1',
      consumerName: 'c1',
      payloadHash: 'h1',
      receivedAt: now,
    });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(now, 'tx1');
    expect(msg.isProcessed()).toBe(true);
    expect(msg.transactionId).toBe('tx1');
  });
});
