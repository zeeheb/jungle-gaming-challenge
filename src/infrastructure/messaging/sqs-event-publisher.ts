import { SendMessageBatchCommand, type SendMessageBatchRequestEntry, type SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { EventPublisher } from '../../application/messaging/relay-outbox';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { QueueUrl } from './queue-url';

/** SendMessageBatch accepts at most 10 entries. */
const MAX_BATCH = 10;

/**
 * Publishes to a FIFO queue. The aggregate (wallet) is the message group, so
 * one wallet's events come out in the order they were sent, and the event id
 * is the deduplication id, so a republished event is dropped by SQS within
 * its 5-minute window (and by consumers, on eventId, after that).
 */
export class SqsEventPublisher implements EventPublisher {
  private readonly logger = new Logger(SqsEventPublisher.name);
  private readonly queue: QueueUrl;

  constructor(
    private readonly sqs: SQSClient,
    queueName: string,
    // the outbox rows stay locked while we wait: never wait for long
    private readonly timeoutMs = 5_000,
  ) {
    this.queue = new QueueUrl(sqs, queueName);
  }

  async publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>> {
    const accepted = new Set<string>();
    try {
      const queueUrl = await this.queue.get();
      for (let start = 0; start < messages.length; start += MAX_BATCH) {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: messages.slice(start, start + MAX_BATCH).map(toEntry) }),
          { abortSignal: AbortSignal.timeout(this.timeoutMs) },
        );
        for (const { Id } of response.Successful ?? []) {
          if (Id) {
            accepted.add(Id);
          }
        }
        for (const failure of response.Failed ?? []) {
          this.logger.warn(`Event ${failure.Id} not accepted by ${this.queue.queueName}: ${failure.Code} ${failure.Message ?? ''}`);
        }
      }
    } catch (error) {
      // whatever was accepted before the failure still counts; the rest is retried
      this.logger.warn(`Publishing to ${this.queue.queueName} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return accepted;
  }
}

function toEntry(message: OutboxMessage): SendMessageBatchRequestEntry {
  return {
    Id: message.id,
    MessageBody: JSON.stringify(message.payload),
    MessageGroupId: message.aggregateId,
    MessageDeduplicationId: message.id,
    MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
  };
}
