import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { UnitOfWork } from '../../src/application/unit-of-work';
import {
  ConsumeWagerMessage,
  WAGER_CONSUMER_NAME,
  WAGER_MESSAGE_TYPE,
} from '../../src/application/wagering/consume-wager-message';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { walletView, type WalletView } from '../../src/http/views';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { SqsWagerConsumer, type WagerConsumerOptions } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { PollingLoop } from '../../src/workers/polling-loop';
import { countTransactions, inconsistentWallets, keyOf, ledgerOf, money, wagerBody, type WagerBody } from '../support/api-fixtures';
import { holdWalletLock, setupTestDatabase, sqlFor, waitForLockWaiter, waitUntil, type Sql } from '../support/database';
import { createTestQueues, drainQueue, queueDepth, sendMessage, testSqsClient, type TestQueues } from '../support/sqs';

let db: MikroORM;
let sql: Sql;
let sqs: SQSClient;
let unitOfWork: UnitOfWork;
let queues: TestQueues;

beforeAll(async () => {
  Logger.overrideLogger(['error']); // retries and dead-letters are expected here
  db = await setupTestDatabase();
  sql = sqlFor(db);
  sqs = testSqsClient();
  unitOfWork = new MikroOrmUnitOfWork(db, { lockTimeoutMs: 5_000 });
});

beforeEach(async () => {
  queues = await createTestQueues(sqs);
});

afterEach(async () => {
  expect(await inconsistentWallets(sql)).toEqual([]);
  await queues.destroy();
});

afterAll(async () => {
  sqs.destroy();
  await db.close(true);
});

/** The consumer as the app builds it, on this test's queues; retries come back immediately unless told otherwise. */
function consumer(options: Partial<WagerConsumerOptions> = {}, uow: UnitOfWork = unitOfWork): SqsWagerConsumer {
  return new SqsWagerConsumer(sqs, new ConsumeWagerMessage(new ProcessWagerTransaction(uow)), {
    queueName: queues.names.transactions,
    deadLetterQueueName: queues.names.deadLetter,
    waitTimeSeconds: 0,
    maxMessages: 10,
    maxAttempts: 5,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    ...options,
  });
}

async function openWallet(amount = '100.00'): Promise<WalletView> {
  const wallet = await new OpenWallet(unitOfWork).execute({
    playerId: `player-${newId()}`,
    initialBalance: Money.from(money(amount)),
    correlationId: 'test',
  });
  return walletView(wallet);
}

interface WagerMessageBody {
  messageId: string;
  type: string;
  occurredAt: string;
  data: WagerBody & { idempotencyKey: string };
}

/** A message in the format of the challenge (section 10). */
function wagerMessage(body: WagerBody, overrides: { messageId?: string; idempotencyKey?: string } = {}): WagerMessageBody {
  return {
    messageId: overrides.messageId ?? `msg-${newId()}`,
    type: WAGER_MESSAGE_TYPE,
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: overrides.idempotencyKey ?? keyOf(body) },
  };
}

/** Sends to this test's queue, grouped by wallet like a provider would. */
const publish = (message: WagerMessageBody | string, groupId = typeof message === 'string' ? 'raw' : message.data.walletId) =>
  sendMessage(sqs, queues.urls.transactions, message, groupId);

async function transactionOf(message: WagerMessageBody) {
  const [row] = await sql(
    `select id, status, failure_code, payload_hash, resulting_balance from wager_transactions
      where provider_id = ? and external_transaction_id = ?`,
    [message.data.providerId, message.data.externalTransactionId],
  );
  return row;
}

const inboxOf = (messageId: string) =>
  sql(
    `select consumer_name, payload_hash, processed_at is not null as processed from inbox_messages where message_id = ?`,
    [messageId],
  );

describe('consuming wager messages', () => {
  it('applies a BET and commits inbox, transaction, ledger and events together, then acks', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wagerBody(wallet, { money: money('25.00') }));
    await publish(message);

    expect(await consumer().poll()).toBe(true);

    const transaction = await transactionOf(message);
    expect(transaction).toMatchObject({ status: 'PROCESSED', resulting_balance: '75.00' });
    expect(await inboxOf(message.messageId)).toEqual([
      { consumer_name: WAGER_CONSUMER_NAME, payload_hash: transaction!['payload_hash'], processed: true },
    ]);
    expect(await ledgerOf(sql, wallet.id)).toHaveLength(2);
    const events = await sql(
      `select event_type, payload ->> 'causationId' as causation_id from outbox_messages
        where payload -> 'data' ->> 'transactionId' = ? order by event_type`,
      [transaction!['id']],
    );
    expect(events).toEqual([
      { event_type: 'WagerTransactionProcessed', causation_id: message.messageId },
      { event_type: 'WalletBalanceChanged', causation_id: message.messageId },
    ]);
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
  });

  it('treats a redelivered message as a duplicate: one debit, one inbox row, acked again', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wagerBody(wallet));
    await publish(message);
    await publish(message); // same messageId, new broker id: what a redelivery looks like

    await consumer().poll();

    expect((await ledgerOf(sql, wallet.id)).filter((entry) => entry['direction'] === 'DEBIT')).toHaveLength(1);
    expect(await inboxOf(message.messageId)).toHaveLength(1);
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
  });

  it('survives a crash between commit and ack: the redelivery is only acked', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wagerBody(wallet));
    // the first delivery committed, then the process died before deleting the message
    await new ConsumeWagerMessage(new ProcessWagerTransaction(unitOfWork)).execute(JSON.stringify(message));
    await publish(message);

    await consumer().poll();

    expect(await ledgerOf(sql, wallet.id)).toHaveLength(2);
    expect((await ledgerOf(sql, wallet.id)).at(-1)).toMatchObject({ balanceAfter: '90.00' });
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
  });

  it('acks a business rejection: the outcome is final, stored and recorded in the inbox', async () => {
    const wallet = await openWallet('5.00');
    const message = wagerMessage(wagerBody(wallet, { money: money('10.00') }));
    await publish(message);

    await consumer().poll();

    expect(await transactionOf(message)).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await inboxOf(message.messageId)).toHaveLength(1);
    expect(await drainQueue(sqs, queues.urls.deadLetter)).toEqual([]);
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
  });

  it("processes a wallet's messages in the order they were sent", async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerBody(wallet);
    const refund = wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    await publish(wagerMessage(bet));
    await publish(wagerMessage(refund));

    await consumer().poll();

    // had the REFUND overtaken its BET, it would be waiting as PENDING_REFERENCE
    expect(await transactionOf(wagerMessage(refund))).toMatchObject({ status: 'PROCESSED', resulting_balance: '100.00' });
  });
});

describe('messages that can never succeed go to the DLQ at once', () => {
  it.each<[string, string, (wallet: WalletView) => WagerMessageBody | string]>([
    ['a body that is not JSON', 'INVALID_PAYLOAD', () => '{"messageId": '],
    ['an unknown message type', 'INVALID_PAYLOAD', (wallet) => ({ ...wagerMessage(wagerBody(wallet)), type: 'WagerCancelled' })],
    ['an amount with three decimals', 'INVALID_PAYLOAD', (wallet) => wagerMessage(wagerBody(wallet, { money: money('1.005') }))],
    ['the internal OPENING kind', 'INVALID_PAYLOAD', (wallet) => wagerMessage(wagerBody(wallet, { kind: 'OPENING' }))],
    ['a wallet that does not exist', 'WALLET_NOT_FOUND', (wallet) => wagerMessage(wagerBody({ ...wallet, id: newId() }))],
  ])('%s → %s', async (_, failureCode, build) => {
    const wallet = await openWallet();
    const message = build(wallet);
    await publish(message);

    await consumer().poll();

    const deadLetters = await drainQueue(sqs, queues.urls.deadLetter);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]!.Body).toBe(typeof message === 'string' ? message : JSON.stringify(message));
    expect(deadLetters[0]!.MessageAttributes?.['failureCode']?.StringValue).toBe(failureCode);
    expect(deadLetters[0]!.MessageAttributes?.['attempts']?.StringValue).toBe('1');
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
    expect(await countTransactions(sql, wallet.id)).toBe(1); // just the OPENING
  });

  it('an Idempotency-Key reused with another payload → IDEMPOTENCY_CONFLICT', async () => {
    const wallet = await openWallet();
    const original = wagerMessage(wagerBody(wallet));
    const reusedKey = wagerMessage(wagerBody(wallet, { money: money('99.00') }), {
      idempotencyKey: original.data.idempotencyKey,
    });
    await publish(original);
    await publish(reusedKey);

    await consumer().poll();

    const [deadLetter] = await drainQueue(sqs, queues.urls.deadLetter);
    expect(deadLetter?.Body).toBe(JSON.stringify(reusedKey));
    expect(deadLetter?.MessageAttributes?.['failureCode']?.StringValue).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('a messageId reused with another payload → MESSAGE_CONFLICT', async () => {
    const wallet = await openWallet();
    const original = wagerMessage(wagerBody(wallet));
    const reusedId = wagerMessage(wagerBody(wallet), { messageId: original.messageId });
    await publish(original);
    await publish(reusedId);

    await consumer().poll();

    const [deadLetter] = await drainQueue(sqs, queues.urls.deadLetter);
    expect(deadLetter?.MessageAttributes?.['failureCode']?.StringValue).toBe('MESSAGE_CONFLICT');
    expect(await transactionOf(reusedId)).toBeUndefined();
  });
});

describe('transient failures', () => {
  it('retries with backoff, writes nothing while failing, and succeeds once the wallet is free', async () => {
    const wallet = await openWallet('100.00');
    const message = wagerMessage(wagerBody(wallet));
    await publish(message);
    // another instance holds the wallet longer than this consumer is willing to wait
    const impatient = consumer(
      { retryBaseDelayMs: 1_000, retryMaxDelayMs: 1_000 },
      new MikroOrmUnitOfWork(db, { lockTimeoutMs: 100 }),
    );
    const lock = await holdWalletLock(db, wallet.id);

    await impatient.poll().finally(() => lock.release());

    expect(await transactionOf(message)).toBeUndefined();
    expect(await inboxOf(message.messageId)).toEqual([]);
    // invisible for the 1s backoff, not deleted and not dead-lettered
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 1 });

    await waitUntil(async () => {
      await impatient.poll();
      return (await transactionOf(message)) !== undefined;
    });
    expect(await transactionOf(message)).toMatchObject({ status: 'PROCESSED' });
    expect(await inboxOf(message.messageId)).toHaveLength(1);
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
  });

  it('gives up after the attempt limit and dead-letters the message with the last error', async () => {
    const wallet = await openWallet();
    const message = wagerMessage(wagerBody(wallet));
    await publish(message);
    const impatient = consumer({ maxAttempts: 2 }, new MikroOrmUnitOfWork(db, { lockTimeoutMs: 100 }));
    const lock = await holdWalletLock(db, wallet.id);

    try {
      await impatient.poll(); // attempt 1: lock timeout, back to the queue
      await impatient.poll(); // attempt 2: the last one
    } finally {
      await lock.release();
    }

    const deadLetters = await drainQueue(sqs, queues.urls.deadLetter);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]!.MessageAttributes?.['failureCode']?.StringValue).toBe('TEMPORARILY_UNAVAILABLE');
    expect(deadLetters[0]!.MessageAttributes?.['attempts']?.StringValue).toBe('2');
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 0 });
    expect(await transactionOf(message)).toBeUndefined();
  });
});

describe('shutdown', () => {
  it('lets the message in progress finish and hands back the ones not started', async () => {
    const wallet = await openWallet('100.00');
    const inProgress = wagerMessage(wagerBody(wallet));
    const notStarted = wagerMessage(wagerBody(wallet));
    await publish(inProgress);
    await publish(notStarted);
    const reader = consumer();
    const loop = new PollingLoop({ name: 'test-consumer', tick: (signal) => reader.poll(signal), idleDelayMs: 0, errorDelayMs: 100 });
    const lock = await holdWalletLock(db, wallet.id); // keeps the first message busy

    loop.start();
    await waitForLockWaiter(sql);
    const stopped = loop.stop(); // SIGTERM arrives while the first message is being processed
    await lock.release();
    await stopped;

    expect(await transactionOf(inProgress)).toMatchObject({ status: 'PROCESSED' });
    expect(await transactionOf(notStarted)).toBeUndefined();
    // back in the queue right away, not after the 30s visibility timeout
    expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 1, inFlight: 0 });

    await consumer().poll(); // the next instance picks it up
    expect(await transactionOf(notStarted)).toMatchObject({ status: 'PROCESSED' });
  });
});
