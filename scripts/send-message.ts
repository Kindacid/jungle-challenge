/**
 * Send a WagerTransactionRequested message to the wager queue (manual testing).
 *
 *   bun scripts/send-message.ts <walletId> <playerId> <amount> [kind] [ext]
 */
import { loadConfig } from '../src/config/app-config.ts';
import { SqsGateway } from '../src/messaging/sqs/sqs-client.ts';

async function main(): Promise<void> {
  const [walletId, playerId, amount, kind = 'BET', ext = crypto.randomUUID()] =
    process.argv.slice(2);
  if (!walletId || !playerId || !amount) {
    throw new Error(
      'usage: bun scripts/send-message.ts <walletId> <playerId> <amount> [kind] [ext]',
    );
  }

  const config = loadConfig();
  const sqs = new SqsGateway(config.sqs);
  const messageId = `msg-${ext}`;
  const body = JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'p',
      externalTransactionId: ext,
      idempotencyKey: `p:${ext}`,
      playerId,
      walletId,
      roundId: 'r-sqs',
      gameId: 'g-sqs',
      kind,
      money: { amount, currency: 'BRL' },
    },
  });

  const id = await sqs.send(config.sqs.wagerQueueUrl, body, {
    messageGroupId: walletId,
    messageDeduplicationId: messageId,
  });
  console.log(`sent messageId=${messageId} (sqs id ${id}) ext=${ext}`);
  sqs.destroy();
}

main().catch((err) => {
  console.error('send failed:', err);
  process.exit(1);
});
