export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
  transactionId?: string;
}

/**
 * Deduplication record for an inbound SQS message, keyed by
 * (consumerName, messageId). Its mere existence under a unique constraint is the
 * dedup guarantee; `processedAt` records when the effect was committed.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
    private _transactionId?: string,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
      state.transactionId,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get transactionId(): string | undefined {
    return this._transactionId;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date, transactionId?: string): void {
    this._processedAt = at;
    this._transactionId = transactionId;
  }
}
