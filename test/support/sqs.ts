import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { env } from '../../src/config/env';
import { newId } from '../../src/domain/shared/id';

export function testSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: env.sqs.endpoint,
    region: env.sqs.region,
    credentials: { accessKeyId: env.sqs.accessKeyId, secretAccessKey: env.sqs.secretAccessKey },
  });
}

export interface TestQueues {
  names: { transactions: string; deadLetter: string; events: string };
  urls: { transactions: string; deadLetter: string; events: string };
  destroy(): Promise<void>;
}

/**
 * Throwaway FIFO queues for one test, configured like the real ones
 * (redrive to the DLQ after 5 receives), so tests never see each other's messages.
 */
export async function createTestQueues(sqs: SQSClient): Promise<TestQueues> {
  const prefix = `test-${newId()}`;
  const create = async (name: string, attributes: Record<string, string> = {}) => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }),
    );
    return QueueUrl!;
  };

  const names = {
    transactions: `${prefix}-transactions.fifo`,
    deadLetter: `${prefix}-dlq.fifo`,
    events: `${prefix}-events.fifo`,
  };
  const deadLetter = await create(names.deadLetter);
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: deadLetter, AttributeNames: ['QueueArn'] }),
  );
  const transactions = await create(names.transactions, {
    VisibilityTimeout: '30',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!['QueueArn'], maxReceiveCount: '5' }),
  });
  const events = await create(names.events);

  const urls = { transactions, deadLetter, events };
  return {
    names,
    urls,
    destroy: async () => {
      await Promise.all(Object.values(urls).map((url) => sqs.send(new DeleteQueueCommand({ QueueUrl: url }))));
    },
  };
}

export async function sendMessage(
  sqs: SQSClient,
  queueUrl: string,
  body: unknown,
  groupId: string,
  deduplicationId: string = newId(),
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

/** Reads and deletes everything visible in a queue (deleting unblocks the next messages of each FIFO group). */
export async function drainQueue(sqs: SQSClient, queueUrl: string): Promise<Message[]> {
  const drained: Message[] = [];
  for (;;) {
    const { Messages: messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    if (messages.length === 0) {
      return drained;
    }
    drained.push(...messages);
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
      }),
    );
  }
}

/** Visible = waiting to be received; in flight = received and not deleted yet (or waiting out a retry delay). */
export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes['ApproximateNumberOfMessages']),
    inFlight: Number(Attributes['ApproximateNumberOfMessagesNotVisible']),
  };
}
