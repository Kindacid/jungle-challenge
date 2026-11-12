/**
 * Idempotently create the FIFO queues used by the service, wiring the DLQ via a
 * redrive policy. Safe to run repeatedly (CreateQueue returns the existing URL
 * when attributes match).
 *
 *   bun scripts/create-queues.ts
 */
import { loadConfig } from '../src/config/app-config.ts';
import { SqsGateway } from '../src/messaging/sqs/sqs-client.ts';

const MAX_RECEIVE_COUNT = 6;

async function waitForSqs(sqs: SqsGateway, attempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      // A throwaway create doubles as a connectivity probe.
      await sqs.createQueue('wager-transactions-dlq.fifo', {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      });
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`SQS not ready (attempt ${i}/${attempts}); retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sqs = new SqsGateway(config.sqs);

  const fifoAttrs = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  await waitForSqs(sqs);

  // DLQ first, so we can reference its ARN in the main queue's redrive policy.
  const dlqUrl = await sqs.createQueue('wager-transactions-dlq.fifo', fifoAttrs);
  const dlqArn = await sqs.getQueueArn(dlqUrl);

  const mainUrl = await sqs.createQueue('wager-transactions.fifo', {
    ...fifoAttrs,
    VisibilityTimeout: String(config.sqs.visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    }),
  });

  const eventsUrl = await sqs.createQueue('wagering-events.fifo', fifoAttrs);

  console.log('queues ready:');
  console.log(`  wager-transactions.fifo      -> ${mainUrl}`);
  console.log(`  wager-transactions-dlq.fifo  -> ${dlqUrl}`);
  console.log(`  wagering-events.fifo         -> ${eventsUrl}`);

  sqs.destroy();
}

main().catch((err) => {
  console.error('queue setup failed:', err);
  process.exit(1);
});
