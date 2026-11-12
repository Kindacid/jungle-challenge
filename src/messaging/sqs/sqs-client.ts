import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../config/app-config.ts';

export interface SendOptions {
  messageGroupId?: string;
  messageDeduplicationId?: string;
  attributes?: Record<string, string>;
}

/**
 * Thin wrapper over the AWS SQS SDK. Depends only on an endpoint URL, so it works
 * identically against MiniStack, LocalStack, or real AWS. FIFO specifics
 * (group/dedup ids) are passed through per call.
 */
export class SqsGateway {
  private readonly client: SQSClient;

  constructor(config: SqsConfig) {
    this.client = new SQSClient({
      region: config.region,
      endpoint: config.endpointUrl,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async send(queueUrl: string, body: string, opts: SendOptions = {}): Promise<string | undefined> {
    const res = await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: opts.messageGroupId,
        MessageDeduplicationId: opts.messageDeduplicationId,
        MessageAttributes: opts.attributes
          ? Object.fromEntries(
              Object.entries(opts.attributes).map(([k, v]) => [
                k,
                { DataType: 'String', StringValue: v },
              ]),
            )
          : undefined,
      }),
    );
    return res.MessageId;
  }

  async receive(
    queueUrl: string,
    maxMessages: number,
    waitTimeSeconds: number,
    visibilityTimeout: number,
  ): Promise<Message[]> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: Math.min(Math.max(maxMessages, 1), 10),
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: visibilityTimeout,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return res.Messages ?? [];
  }

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  async changeMessageVisibility(
    queueUrl: string,
    receiptHandle: string,
    visibilityTimeout: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, visibilityTimeout),
      }),
    );
  }

  /** Readiness probe: SQS is reachable and the queue exists. */
  async ping(queueUrl: string): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
  }

  async createQueue(name: string, attributes: Record<string, string>): Promise<string> {
    const res = await this.client.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    );
    if (!res.QueueUrl) throw new Error(`failed to create queue ${name}`);
    return res.QueueUrl;
  }

  async getQueueArn(queueUrl: string): Promise<string> {
    const res = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
    const arn = res.Attributes?.QueueArn;
    if (!arn) throw new Error(`queue ${queueUrl} has no ARN`);
    return arn;
  }

  destroy(): void {
    this.client.destroy();
  }
}
