import { type AppConfig, loadConfig } from '../../src/config/app-config.ts';
import { SqsGateway } from '../../src/messaging/sqs/sqs-client.ts';

export interface TestQueues {
  sqs: SqsGateway;
  mainUrl: string;
  dlqUrl: string;
  /** A config whose SQS section points at these queues, with short polling. */
  config: AppConfig;
  cleanup(): void;
}

/**
 * Create isolated FIFO queues (main + DLQ with a redrive policy) in MiniStack for
 * one test, and a config pointing at them. Requires MiniStack to be running.
 */
export async function createTestQueues(): Promise<TestQueues> {
  const base = loadConfig();
  const sqs = new SqsGateway(base.sqs);
  const rand = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  const dlqUrl = await sqs.createQueue(`test-dlq-${rand}.fifo`, fifo);
  const dlqArn = await sqs.getQueueArn(dlqUrl);
  const mainUrl = await sqs.createQueue(`test-main-${rand}.fifo`, {
    ...fifo,
    VisibilityTimeout: '2',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 3 }),
  });

  const config: AppConfig = {
    ...base,
    role: 'worker',
    sqs: {
      ...base.sqs,
      wagerQueueUrl: mainUrl,
      wagerDlqUrl: dlqUrl,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 2,
    },
    worker: { ...base.worker, consumerMaxAttempts: 3 },
  };

  return {
    sqs,
    mainUrl,
    dlqUrl,
    config,
    cleanup() {
      sqs.destroy();
    },
  };
}
