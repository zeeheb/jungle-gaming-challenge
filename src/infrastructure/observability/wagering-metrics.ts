import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/** State that is read when Prometheus scrapes, rather than counted as it happens. */
export interface MetricSources {
  /** Unpublished outbox messages and the age of the oldest one, in seconds. */
  outboxBacklog(): Promise<{ pending: number; oldestAgeSeconds: number }>;
  /** Messages sitting in the transactions DLQ. */
  deadLetterQueueDepth(): Promise<number>;
}

/**
 * Every metric the service exposes on GET /metrics (Prometheus text format).
 * Its own registry, not prom-client's global one, so tests and several app
 * instances in one process never mix their numbers.
 */
export class WageringMetrics {
  readonly registry = new Registry();

  /** Outcomes decided now, by status: PROCESSED, REJECTED, PENDING_REFERENCE. Replays are not counted here. */
  readonly transactions: Counter<'entrypoint' | 'kind' | 'status'>;
  /** Submissions answered from a stored outcome: same Idempotency-Key, or the same queue message again. */
  readonly duplicates: Counter<'type'>;
  readonly idempotencyConflicts: Counter<'entrypoint'>;
  /** Time to answer a submission, wallet lock wait included. */
  readonly processingDuration: Histogram<'entrypoint'>;
  /** Lock timeouts, deadlocks and serialization failures: answered as 503 or retried. */
  readonly lockConflicts: Counter<'reason'>;
  readonly messageRetries: Counter<'code'>;
  readonly messagesDeadLettered: Counter<'code'>;
  readonly eventsPublished: Counter;
  readonly eventPublishFailures: Counter;
  /** Pending-reference lookups, by the status the transaction was left in. */
  readonly referenceRetries: Counter<'status'>;
  readonly reconciliations: Counter<'result'>;

  constructor(sources?: MetricSources) {
    const registers = [this.registry];

    this.transactions = new Counter({
      name: 'wagering_transactions_total',
      help: 'Wager transactions decided, by entrypoint, kind and resulting status',
      labelNames: ['entrypoint', 'kind', 'status'],
      registers,
    });
    this.duplicates = new Counter({
      name: 'wagering_duplicates_total',
      help: 'Duplicate submissions answered with the stored outcome (idempotency-key or message)',
      labelNames: ['type'],
      registers,
    });
    this.idempotencyConflicts = new Counter({
      name: 'wagering_idempotency_conflicts_total',
      help: 'Idempotency keys or external ids reused with a different payload',
      labelNames: ['entrypoint'],
      registers,
    });
    this.processingDuration = new Histogram({
      name: 'wagering_processing_duration_seconds',
      help: 'Time to answer a wager submission, including the wait for the wallet lock',
      labelNames: ['entrypoint'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.lockConflicts = new Counter({
      name: 'wagering_lock_conflicts_total',
      help: 'Database lock conflicts: lock_timeout, deadlock or serialization failure',
      labelNames: ['reason'],
      registers,
    });
    this.messageRetries = new Counter({
      name: 'wagering_message_retries_total',
      help: 'Queue messages sent back to the queue to be retried, by failure code',
      labelNames: ['code'],
      registers,
    });
    this.messagesDeadLettered = new Counter({
      name: 'wagering_messages_dead_lettered_total',
      help: 'Queue messages moved to the DLQ by the consumer, by failure code',
      labelNames: ['code'],
      registers,
    });
    this.eventsPublished = new Counter({
      name: 'wagering_outbox_published_total',
      help: 'Outbox events accepted by the broker',
      registers,
    });
    this.eventPublishFailures = new Counter({
      name: 'wagering_outbox_publish_failures_total',
      help: 'Outbox events the broker did not accept; they are retried with backoff',
      registers,
    });
    this.referenceRetries = new Counter({
      name: 'wagering_reference_retries_total',
      help: 'Lookups of a missing reference by the worker, by the resulting status',
      labelNames: ['status'],
      registers,
    });
    this.reconciliations = new Counter({
      name: 'wagering_reconciliations_total',
      help: 'Wallet reconciliations, by result (consistent or inconsistent)',
      labelNames: ['result'],
      registers,
    });

    if (sources) {
      // read at scrape time; NaN when the source is down, rather than a stale number
      gauge(registers, 'wagering_outbox_pending_messages', 'Outbox events not published yet', async () =>
        (await sources.outboxBacklog()).pending,
      );
      gauge(registers, 'wagering_outbox_lag_seconds', 'Age of the oldest unpublished outbox event', async () =>
        (await sources.outboxBacklog()).oldestAgeSeconds,
      );
      gauge(registers, 'wagering_dead_letter_queue_messages', 'Messages waiting in the transactions DLQ', () =>
        sources.deadLetterQueueDepth(),
      );
    }
  }
}

function gauge(registers: Registry[], name: string, help: string, read: () => Promise<number>): void {
  new Gauge({
    name,
    help,
    registers,
    async collect() {
      this.set(await read().catch(() => Number.NaN));
    },
  });
}
