import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { ConsumeWagerMessage, MessageOutcome } from '../../application/wagering/consume-wager-message';
import { exponentialBackoff } from '../../domain/shared/backoff';
import { logContext } from '../observability/log-context';
import type { WageringMetrics } from '../observability/wagering-metrics';
import { QueueUrl } from './queue-url';

export interface WagerConsumerOptions {
  queueName: string;
  deadLetterQueueName: string;
  /** Long-poll duration of each receive, in seconds (SQS allows up to 20). */
  waitTimeSeconds: number;
  maxMessages: number;
  /**
   * Receives before a failing message is moved to the DLQ by us, with the
   * reason attached. Keep it at most the queue's maxReceiveCount: the broker's
   * own redrive is only the safety net for a consumer that crashes on a message.
   */
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

/**
 * Reads wager-transactions.fifo. The message is deleted (acked) only after the
 * use case has committed, so a crash at any point means a redelivery, and the
 * inbox makes a redelivery harmless.
 */
export class SqsWagerConsumer {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly queue: QueueUrl;
  private readonly deadLetterQueue: QueueUrl;

  constructor(
    private readonly sqs: SQSClient,
    private readonly consume: ConsumeWagerMessage,
    private readonly options: WagerConsumerOptions,
    private readonly metrics?: WageringMetrics,
  ) {
    this.queue = new QueueUrl(sqs, options.queueName);
    this.deadLetterQueue = new QueueUrl(sqs, options.deadLetterQueueName);
  }

  /**
   * One receive cycle: long-polls a batch and settles every message in it.
   * Resolves true when messages came in. Once `signal` aborts, the long poll is
   * cancelled, messages already being handled finish normally, and the ones not
   * started yet go back to the queue at once.
   */
  async poll(signal?: AbortSignal): Promise<boolean> {
    const queueUrl = await this.queue.get();
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: signal },
    );

    // FIFO groups are wallets: one group's messages in order, different groups in parallel
    await Promise.all([...byGroup(messages).values()].map((group) => this.handleGroup(queueUrl, group, signal)));
    return messages.length > 0;
  }

  private async handleGroup(queueUrl: string, group: Message[], signal: AbortSignal | undefined): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (signal?.aborted) {
        await this.release(queueUrl, group.slice(index));
        return;
      }
      // every log line about this message carries the broker's id for it
      const settled = await logContext.run({ sqsMessageId: message.MessageId }, () => this.handle(queueUrl, message));
      if (!settled) {
        // the failed message comes back later, and the rest of its group must not overtake it
        await this.release(queueUrl, group.slice(index + 1));
        return;
      }
    }
  }

  /** Settles one message. Resolves false if it stays in the queue to be retried. */
  private async handle(queueUrl: string, message: Message): Promise<boolean> {
    const attempt = Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1');
    const outcome = await this.consume.execute(message.Body ?? '').catch((error: unknown): MessageOutcome => {
      this.logger.error({ msg: 'unexpected error while handling a message', error: describe(error), attempt });
      return { action: 'retry', code: 'UNEXPECTED_ERROR', reason: describe(error) };
    });

    try {
      if (outcome.action === 'ack') {
        await this.delete(queueUrl, message);
        return true;
      }
      if (outcome.action === 'dead-letter' || attempt >= this.options.maxAttempts) {
        await this.deadLetter(queueUrl, message, outcome.code, outcome.reason, attempt);
        return true;
      }
      // Retry with backoff: the message stays invisible for a while, then SQS delivers it again.
      const delayMs = exponentialBackoff(attempt, this.options.retryBaseDelayMs, this.options.retryMaxDelayMs);
      this.metrics?.messageRetries.inc({ code: outcome.code });
      this.logger.warn({
        msg: 'message will be retried',
        code: outcome.code,
        attempt,
        maxAttempts: this.options.maxAttempts,
        retryInMs: delayMs,
      });
      await this.setVisibility(queueUrl, message, Math.ceil(delayMs / 1_000));
      return false;
    } catch (error) {
      // Could not ack or move it: it reappears after its visibility timeout,
      // and whatever was committed turns that redelivery into a duplicate.
      this.logger.error({ msg: 'could not ack or move the message in SQS', error: describe(error) });
      return false;
    }
  }

  private async deadLetter(queueUrl: string, message: Message, code: string, reason: string, attempt: number) {
    this.metrics?.messagesDeadLettered.inc({ code });
    this.logger.warn({ msg: 'message sent to the DLQ', code, reason, attempt });
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.deadLetterQueue.get(),
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.['MessageGroupId'] ?? 'dead-letter',
        // the broker's id is the same on every redelivery, so moving one message twice leaves one copy
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: code },
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 1_000) },
          attempts: { DataType: 'Number', StringValue: String(attempt) },
        },
      }),
    );
    await this.delete(queueUrl, message);
  }

  private async delete(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async setVisibility(queueUrl: string, message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }),
    );
  }

  private async release(queueUrl: string, messages: Message[]): Promise<void> {
    await Promise.all(
      messages.map((message) =>
        this.setVisibility(queueUrl, message, 0).catch((error: unknown) =>
          this.logger.warn({ msg: 'could not release message', sqsMessageId: message.MessageId, error: describe(error) }),
        ),
      ),
    );
  }
}

function byGroup(messages: Message[]): Map<string, Message[]> {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const group = message.Attributes?.['MessageGroupId'] ?? message.MessageId ?? '';
    groups.set(group, [...(groups.get(group) ?? []), message]);
  }
  return groups;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
