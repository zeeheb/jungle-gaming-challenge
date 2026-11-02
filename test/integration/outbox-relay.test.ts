import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { RelayOutbox, type EventPublisher } from '../../src/application/messaging/relay-outbox';
import type { UnitOfWork } from '../../src/application/unit-of-work';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { money } from '../support/api-fixtures';
import { setupTestDatabase, sqlFor, waitUntil, type Sql } from '../support/database';
import { createTestQueues, drainQueue, testSqsClient, type TestQueues } from '../support/sqs';

let db: MikroORM;
let sql: Sql;
let sqs: SQSClient;
let unitOfWork: UnitOfWork;
let queues: TestQueues;

beforeAll(async () => {
  Logger.overrideLogger(['error']); // the unreachable-broker test logs warnings on purpose
  db = await setupTestDatabase();
  sql = sqlFor(db);
  sqs = testSqsClient();
  unitOfWork = new MikroOrmUnitOfWork(db, { lockTimeoutMs: 5_000 });
});

beforeEach(async () => {
  queues = await createTestQueues(sqs);
});

afterEach(async () => {
  await queues.destroy();
});

afterAll(async () => {
  sqs.destroy();
  await db.close(true);
});

const publisher = () => new SqsEventPublisher(sqs, queues.names.events);
const relayWith = (eventPublisher: EventPublisher, batchSize = 10) => new RelayOutbox(unitOfWork, eventPublisher, batchSize);

/** Relays until nothing due is left (or every remaining row is held by another relay). */
async function relayAll(relay: RelayOutbox): Promise<void> {
  while ((await relay.relayBatch()).claimed > 0) {
    // keep going
  }
}

/** A wallet whose opening already queued two events (WagerTransactionProcessed, WalletBalanceChanged). */
async function openWallet(amount = '100.00'): Promise<string> {
  const wallet = await new OpenWallet(unitOfWork).execute({
    playerId: `player-${newId()}`,
    initialBalance: Money.from(money(amount)),
    correlationId: 'test',
  });
  return wallet.id;
}

async function bet(walletId: string): Promise<void> {
  const [wallet] = await sql(`select player_id from wallets where id = ?`, [walletId]);
  await new ProcessWagerTransaction(unitOfWork).execute({
    idempotencyKey: `key-${newId()}`,
    payload: {
      providerId: 'provider-a',
      externalTransactionId: `ext-${newId()}`,
      playerId: wallet!['player_id'] as string,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from(money('10.00')),
    },
    correlationId: 'test',
  });
}

const outboxOf = (walletIds: string[]) =>
  sql(
    `select id, published_at, attempts, next_attempt_at from outbox_messages
      where aggregate_id in (${walletIds.map(() => '?').join(', ')}) order by occurred_at, id`,
    walletIds,
  );

/** Counts every message handed to the broker, on top of really publishing it. */
class RecordingPublisher implements EventPublisher {
  readonly sends = new Map<string, number>();

  constructor(private readonly inner: EventPublisher) {}

  publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>> {
    for (const message of messages) {
      this.sends.set(message.id, (this.sends.get(message.id) ?? 0) + 1);
    }
    return this.inner.publish(messages);
  }
}

describe('outbox relay', () => {
  it('publishes committed events in commit order, grouped by wallet and deduplicated by event id', async () => {
    const walletId = await openWallet();
    await bet(walletId);
    const rows = await outboxOf([walletId]);

    await relayAll(relayWith(publisher()));

    const delivered = (await drainQueue(sqs, queues.urls.events))
      .map((message) => ({ message, envelope: JSON.parse(message.Body!) }))
      .filter(({ envelope }) => envelope.aggregateId === walletId);
    expect(delivered.map(({ envelope }) => envelope.eventId)).toEqual(rows.map((row) => row['id']));
    expect(delivered.map(({ envelope }) => envelope.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const { message, envelope } of delivered) {
      expect(message.Attributes?.['MessageGroupId']).toBe(walletId);
      expect(message.Attributes?.['MessageDeduplicationId']).toBe(envelope.eventId);
      expect(message.MessageAttributes?.['eventType']?.StringValue).toBe(envelope.eventType);
    }
    for (const row of await outboxOf([walletId])) {
      expect(row['published_at']).not.toBeNull();
      expect(row['attempts']).toBe(0);
    }
  });

  it('with three relays on the same outbox, hands every event to the broker exactly once', async () => {
    const walletIds = await Promise.all(Array.from({ length: 20 }, () => openWallet('10.00')));
    const recorder = new RecordingPublisher(publisher());

    // small batches so the relays keep running into each other's locked rows
    await Promise.all([relayAll(relayWith(recorder, 3)), relayAll(relayWith(recorder, 3)), relayAll(relayWith(recorder, 3))]);

    const rows = await outboxOf(walletIds);
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      expect(row['published_at']).not.toBeNull();
      expect(recorder.sends.get(row['id'] as string)).toBe(1);
    }
  });

  it('when the relay dies after the broker accepted a batch, the next one republishes it and the copy is dropped', async () => {
    const walletId = await openWallet();
    const crashing: EventPublisher = {
      publish: async (messages) => {
        await publisher().publish(messages);
        throw new Error('process died before committing');
      },
    };

    await expect(relayWith(crashing).relayBatch()).rejects.toThrow('process died');

    // the database transaction rolled back: still pending, nothing lost
    expect((await outboxOf([walletId])).map((row) => row['published_at'])).toEqual([null, null]);

    await relayAll(relayWith(publisher()));

    expect((await outboxOf([walletId])).every((row) => row['published_at'] !== null)).toBe(true);
    // published twice, delivered once: the event id is the FIFO deduplication id
    const delivered = (await drainQueue(sqs, queues.urls.events)).filter(
      (message) => JSON.parse(message.Body!).aggregateId === walletId,
    );
    expect(delivered).toHaveLength(2);
  });

  it('keeps the events and retries with backoff while the broker is unreachable', async () => {
    const walletId = await openWallet();
    const before = new Date();

    await relayWith(new SqsEventPublisher(sqs, `missing-${newId()}.fifo`)).relayBatch();

    for (const row of await outboxOf([walletId])) {
      expect(row['published_at']).toBeNull();
      expect(row['attempts']).toBe(1);
      expect(new Date(row['next_attempt_at'] as string).getTime()).toBeGreaterThan(before.getTime());
    }

    // once the broker is back and the backoff (1s) has passed, they go out
    await waitUntil(async () => {
      await relayAll(relayWith(publisher()));
      return (await outboxOf([walletId])).every((row) => row['published_at'] !== null);
    });
  });
});
