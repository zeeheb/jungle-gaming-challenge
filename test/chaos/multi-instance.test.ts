import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FAULT_EXIT_CODE } from '../../src/app.module';
import { WAGER_MESSAGE_TYPE } from '../../src/application/wagering/consume-wager-message';
import { newId } from '../../src/domain/shared/id';
import type { WalletView } from '../../src/http/views';
import { inconsistentWallets, keyOf, money, wagerBody, type WagerBody } from '../support/api-fixtures';
import { setupTestDatabase, sqlFor, waitUntil, type Sql } from '../support/database';
import { metricValue } from '../support/metrics';
import { createTestQueues, drainQueue, queueDepth, sendMessage, testSqsClient, type TestQueues } from '../support/sqs';
import { startInstance, type Instance } from './support/instances';

// Real processes (`bun src/main.ts`), each with its own connection pool and
// its own consumer, outbox relay and pending-reference worker, all on one
// database and one set of queues: what several pods of the service would be.
// Crashes are real too: SIGKILL, no shutdown hooks.

const TEST_TIMEOUT_MS = 120_000;
const SETTLE_TIMEOUT_MS = 60_000;
/** Short, so a message held by a dead process comes back quickly. */
const VISIBILITY_TIMEOUT_SECONDS = 2;

let db: MikroORM;
let sql: Sql;
let sqs: SQSClient;
const running: Instance[] = [];
const queueSets: TestQueues[] = [];

beforeAll(async () => {
  db = await setupTestDatabase();
  sql = sqlFor(db);
  sqs = testSqsClient();
});

afterAll(async () => {
  await Promise.all(running.map((instance) => instance.kill()));
  await Promise.all(queueSets.map((queues) => queues.destroy()));
  sqs.destroy();
  await db.close(true);
});

async function newQueues(): Promise<TestQueues> {
  const queues = await createTestQueues(sqs, VISIBILITY_TIMEOUT_SECONDS);
  queueSets.push(queues);
  return queues;
}

async function start(name: string, queues: TestQueues, env: Record<string, string> = {}): Promise<Instance> {
  const instance = await startInstance(name, queues, env);
  running.push(instance);
  return instance;
}

async function openWallet(instance: Instance, amount: string): Promise<WalletView> {
  const response = await fetch(`${instance.url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: `player-${newId()}`, initialBalance: money(amount) }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<WalletView>;
}

async function postWager(instance: Instance, body: WagerBody) {
  const response = await fetch(`${instance.url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': keyOf(body) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { transactionId: string; idempotentReplay: boolean } };
}

const wagerMessage = (body: WagerBody) => ({
  messageId: `msg-${newId()}`,
  type: WAGER_MESSAGE_TYPE,
  occurredAt: new Date().toISOString(),
  data: { ...body, idempotencyKey: keyOf(body) },
});

const publish = (queues: TestQueues, message: ReturnType<typeof wagerMessage>) =>
  sendMessage(sqs, queues.urls.transactions, message, message.data.walletId);

/** Nothing left to do anywhere: queue drained, no reference waiting, every event published. */
async function settled(queues: TestQueues): Promise<boolean> {
  const depth = await queueDepth(sqs, queues.urls.transactions);
  const [row] = await sql(
    `select (select count(*) from wager_transactions where status = 'PENDING_REFERENCE')::int as waiting,
            (select count(*) from outbox_messages where published_at is null)::int as unpublished`,
  );
  return depth.visible === 0 && depth.inFlight === 0 && row!['waiting'] === 0 && row!['unpublished'] === 0;
}

async function walletState(walletId: string) {
  const [row] = await sql(
    `select w.balance,
            (select count(*) from wager_transactions t where t.wallet_id = w.id)::int as transactions,
            (select count(*) from wallet_ledger_entries e where e.wallet_id = w.id and e.direction = 'DEBIT')::int as debits
       from wallets w where w.id = ?`,
    [walletId],
  );
  return row!;
}

describe('three instances on one database and one queue', () => {
  it(
    'share the work and keep every invariant, with duplicated, out-of-order and racing requests',
    async () => {
      const queues = await newQueues();
      const instances = await Promise.all(['a', 'b', 'c'].map((name) => start(name, queues)));

      // Through the queue: per wallet, a REFUND that arrives before its BET
      // and 15 bets, every message delivered twice.
      const queued = await Promise.all(Array.from({ length: 6 }, () => openWallet(instances[0]!, '100.00')));
      for (const wallet of queued) {
        const bets = Array.from({ length: 15 }, () => wagerBody(wallet, { money: money('1.00') }));
        const refund = wagerBody(wallet, {
          kind: 'REFUND',
          money: money('1.00'),
          referenceExternalTransactionId: bets[0]!.externalTransactionId,
        });
        for (const message of [refund, ...bets].map(wagerMessage)) {
          await publish(queues, message);
          await publish(queues, message);
        }
      }

      // Through HTTP, racing across processes: 100.00 and two 80.00 bets on two instances...
      const contested = await openWallet(instances[0]!, '100.00');
      const rivals = [wagerBody(contested, { money: money('80.00') }), wagerBody(contested, { money: money('80.00') })];
      const raced = await Promise.all(rivals.map((bet, index) => postWager(instances[index]!, bet)));
      expect(raced.map((response) => response.status).sort()).toEqual([200, 422]);

      // ...and the same bet 30 times, spread over the three of them.
      const hot = await openWallet(instances[1]!, '100.00');
      const same = wagerBody(hot);
      const copies = await Promise.all(Array.from({ length: 30 }, (_, index) => postWager(instances[index % 3]!, same)));
      expect(copies.every((response) => response.status === 200)).toBe(true);
      expect(copies.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);

      await waitUntil(() => settled(queues), SETTLE_TIMEOUT_MS);

      expect(await inconsistentWallets(sql)).toEqual([]);
      for (const wallet of queued) {
        // 100 - 15 bets + the refunded one; OPENING + 15 BETs + 1 REFUND, each exactly once
        expect(await walletState(wallet.id)).toEqual({ balance: '86.00', transactions: 17, debits: 15 });
      }
      expect(await walletState(contested.id)).toEqual({ balance: '20.00', transactions: 3, debits: 1 });
      expect(await walletState(hot.id)).toEqual({ balance: '90.00', transactions: 2, debits: 1 });
      const [inbox] = await sql(`select count(*)::int as messages from inbox_messages`);
      expect(inbox!['messages']).toBe(6 * 16); // the copies were recognised, not stored

      // Three relays, one outbox: every event handed to the broker exactly once
      const [outbox] = await sql(`select count(*)::int as events from outbox_messages`);
      const published = await Promise.all(instances.map(async (instance) => metricValue(await instance.metrics(), 'wagering_outbox_published_total')));
      expect(published.reduce((sum, count) => sum + count, 0)).toBe(outbox!['events'] as number);
      const delivered = await drainQueue(sqs, queues.urls.events);
      expect(new Set(delivered.map((message) => JSON.parse(message.Body!).eventId)).size).toBe(outbox!['events'] as number);

      // and the queue really was shared
      const consumers = instances.filter((instance) =>
        instance.logs.some((line) => line['msg'] === 'transaction decided' && line['entrypoint'] === 'queue'),
      );
      expect(consumers.length).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a worker killed after the commit and before the ack', () => {
  it(
    'leaves the message to be redelivered, and the redelivery only acknowledges it',
    async () => {
      const queues = await newQueues();
      const doomed = await start('doomed', queues, { FAULT_CRASH_AFTER_COMMIT: 'true' });
      const wallet = await openWallet(doomed, '100.00');
      const message = wagerMessage(wagerBody(wallet, { money: money('10.00') }));
      await publish(queues, message);

      expect(await doomed.exited).toBe(FAULT_EXIT_CODE);

      // committed: transaction, ledger and inbox are there...
      expect(await walletState(wallet.id)).toEqual({ balance: '90.00', transactions: 2, debits: 1 });
      expect(await sql(`select message_id from inbox_messages where message_id = ?`, [message.messageId])).toHaveLength(1);
      // ...but the message was never deleted
      expect(await queueDepth(sqs, queues.urls.transactions)).toEqual({ visible: 0, inFlight: 1 });

      const survivor = await start('survivor', queues);
      await waitUntil(() => settled(queues), SETTLE_TIMEOUT_MS);

      expect(await walletState(wallet.id)).toEqual({ balance: '90.00', transactions: 2, debits: 1 });
      expect(metricValue(await survivor.metrics(), 'wagering_duplicates_total', { type: 'message' })).toBe(1);
      expect(await inconsistentWallets(sql)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('an instance killed under load, then a full restart', () => {
  it(
    'loses nothing, duplicates nothing, and every wallet reconciles after the restart',
    async () => {
      const queues = await newQueues();
      const instances = await Promise.all(['d', 'e', 'f'].map((name) => start(name, queues)));
      const wallets = await Promise.all(Array.from({ length: 4 }, () => openWallet(instances[0]!, '100.00')));
      const messages = wallets.flatMap((wallet) =>
        Array.from({ length: 40 }, () => wagerMessage(wagerBody(wallet, { money: money('1.00') }))),
      );
      await Promise.all(messages.map((message) => publish(queues, message)));

      // kill one instance while the others are busy, then start a replacement
      await waitUntil(async () => {
        const [row] = await sql(`select count(*)::int as done from inbox_messages`);
        return (row!['done'] as number) >= 20;
      }, SETTLE_TIMEOUT_MS);
      await instances[1]!.kill();
      await start('e-replacement', queues);
      await waitUntil(() => settled(queues), SETTLE_TIMEOUT_MS);

      // full restart: everything goes down hard, one fresh instance comes up
      await Promise.all(running.map((instance) => instance.kill()));
      const fresh = await start('after-restart', queues);

      for (const wallet of wallets) {
        expect(await walletState(wallet.id)).toEqual({ balance: '60.00', transactions: 41, debits: 40 });
        const response = await fetch(`${fresh.url}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
        expect(await response.json()).toMatchObject({ consistent: true, checkedEntries: 41 });
      }
      // raw SQL expands an array parameter into a comma-separated list
      const [inbox] = await sql(`select count(*)::int as messages from inbox_messages where message_id in (?)`, [
        messages.map((message) => message.messageId),
      ]);
      expect(inbox!['messages']).toBe(messages.length);
      expect(await inconsistentWallets(sql)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
