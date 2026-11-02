import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { UnitOfWork } from '../unit-of-work';

/** Port to the message broker. */
export interface EventPublisher {
  /**
   * Sends the messages and returns the ids the broker accepted. It does not
   * throw: if the broker is unreachable, nothing was accepted and every
   * message is simply retried later.
   */
  publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>>;
}

export interface RelayResult {
  claimed: number;
  published: number;
}

/**
 * Moves committed events from the outbox to the broker. Events are only ever
 * written by the transaction that changed the money, so nothing is published
 * before that commit.
 *
 * Delivery is at least once. If the process dies after the broker accepted a
 * batch but before this transaction commits, the rows are still pending and
 * get published again. That is safe: the event id doubles as the broker's
 * deduplication id and as the consumers' deduplication key.
 */
export class RelayOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly batchSize: number,
  ) {}

  async relayBatch(): Promise<RelayResult> {
    return this.unitOfWork.run(async ({ outbox }) => {
      const now = new Date();
      // Locked rows are skipped, so concurrent relays (one per instance) never
      // pick the same message while it is being published.
      const due = await outbox.claimDue(now, this.batchSize);
      if (due.length === 0) {
        return { claimed: 0, published: 0 };
      }

      const accepted = await this.publisher.publish(due);
      const publishedAt = new Date();
      for (const message of due) {
        if (accepted.has(message.id)) {
          message.markPublished(publishedAt);
        } else {
          message.scheduleRetry(now);
        }
        outbox.update(message);
      }
      return { claimed: due.length, published: accepted.size };
    });
  }
}
