import { addMilliseconds, exponentialBackoff } from '../shared/backoff';
import type { IntegrationEvent } from '../events/integration-event';

/**
 * Publishing is retried forever: dropping a committed event is not an option.
 * A message stuck here shows up as outbox lag in the metrics instead.
 */
export const OUTBOX_RETRY = { baseDelayMs: 1_000, maxDelayMs: 60_000 } as const;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** The event id is reused as outbox id, so consumers can deduplicate on it. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error(`Outbox message ${this.id} was already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new Error(`Outbox message ${this.id} was already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = addMilliseconds(now, exponentialBackoff(this._attempts, OUTBOX_RETRY.baseDelayMs, OUTBOX_RETRY.maxDelayMs));
  }
}
