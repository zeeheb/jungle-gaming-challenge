import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { UNIT_OF_WORK } from '../../src/application/unit-of-work';
import { newId } from '../../src/domain/shared/id';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import {
  balanceOf,
  countTransactions,
  inconsistentWallets,
  keyOf,
  ledgerOf,
  money,
  openWallet,
  submit,
  wagerBody,
} from '../support/api-fixtures';
import { startApp, type TestApp } from '../support/app';
import {
  holdWalletLock,
  inTransaction,
  lockWaiters,
  setupTestDatabase,
  sqlFor,
  waitForLockWaiter,
  type Sql,
} from '../support/database';
import { insertTransaction } from '../support/schema-fixtures';

// Real parallelism: every request below goes through HTTP to the real app and
// its connection pool, so they really overlap inside PostgreSQL. Interleavings
// that matter are forced with locks held by the test, never with sleeps.

const PARALLEL_TIMEOUT_MS = 30_000;

let db: MikroORM;
let sql: Sql;
let app: TestApp;

beforeAll(async () => {
  db = await setupTestDatabase();
  sql = sqlFor(db);
  app = await startApp();
});

afterEach(async () => {
  expect(await inconsistentWallets(sql)).toEqual([]);
});

afterAll(async () => {
  await app.close();
  await db.close(true);
});

const debitsOf = async (walletId: string) =>
  (await ledgerOf(sql, walletId)).filter((entry) => entry['direction'] === 'DEBIT');

describe('one wallet, many concurrent requests', () => {
  it(
    'applies the same bet sent 50 times in parallel exactly once',
    async () => {
      const wallet = await openWallet(app.api, '100.00');
      const bet = wagerBody(wallet);

      const responses = await Promise.all(Array.from({ length: 50 }, () => submit(app.api, bet)));

      expect(responses.map((response) => response.status)).toEqual(Array<number>(50).fill(200));
      expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
      expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
      expect(responses.every((response) => response.body.balance.amount === '90.00')).toBe(true);
      expect(await debitsOf(wallet.id)).toHaveLength(1);
      expect(await balanceOf(app.api, wallet.id)).toBe('90.00');
    },
    PARALLEL_TIMEOUT_MS,
  );

  it(
    'lets only one of two 80.00 bets through a 100.00 balance, and retries change nothing',
    async () => {
      const wallet = await openWallet(app.api, '100.00');
      const bets = [wagerBody(wallet, { money: money('80.00') }), wagerBody(wallet, { money: money('80.00') })];

      const responses = await Promise.all(bets.map((bet) => submit(app.api, bet)));

      expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
      expect(responses.find((response) => response.status === 422)!.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
      });
      expect(await balanceOf(app.api, wallet.id)).toBe('20.00');
      expect(await debitsOf(wallet.id)).toHaveLength(1);

      const retries = await Promise.all(bets.map((bet) => submit(app.api, bet)));

      expect(retries.map((retry) => retry.status)).toEqual(responses.map((response) => response.status));
      expect(retries.every((retry) => retry.body.idempotentReplay)).toBe(true);
      expect(await balanceOf(app.api, wallet.id)).toBe('20.00');
      expect(await debitsOf(wallet.id)).toHaveLength(1);
    },
    PARALLEL_TIMEOUT_MS,
  );

  it(
    'never overdraws a hot wallet hit by a burst of distinct bets',
    async () => {
      const wallet = await openWallet(app.api, '50.00');

      const responses = await Promise.all(
        Array.from({ length: 100 }, () => submit(app.api, wagerBody(wallet, { money: money('1.00') }))),
      );

      expect(responses.filter((response) => response.status === 200)).toHaveLength(50);
      expect(responses.filter((response) => response.status === 422)).toHaveLength(50);
      expect(await balanceOf(app.api, wallet.id)).toBe('0.00');
      // one entry per version, no gaps: every debit saw the one before it
      const versions = (await ledgerOf(sql, wallet.id)).map((entry) => entry['version']);
      expect(versions).toEqual(Array.from({ length: 51 }, (_, index) => index + 1));
    },
    PARALLEL_TIMEOUT_MS,
  );
});

describe('different wallets', () => {
  it(
    'are processed in parallel, each one ending with the right balance',
    async () => {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(app.api, '100.00')));

      const responses = await Promise.all(
        wallets.flatMap((wallet) =>
          Array.from({ length: 10 }, () => submit(app.api, wagerBody(wallet, { money: money('5.00') }))),
        ),
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
      for (const wallet of wallets) {
        expect(await balanceOf(app.api, wallet.id)).toBe('50.00');
        expect(await debitsOf(wallet.id)).toHaveLength(10);
      }
    },
    PARALLEL_TIMEOUT_MS,
  );

  it("never wait for each other's lock (there is no global lock)", async () => {
    const busy = await openWallet(app.api, '100.00');
    const free = await openWallet(app.api, '100.00');
    const lock = await holdWalletLock(db, busy.id); // another instance is working on `busy`

    const blocked = submit(app.api, wagerBody(busy));
    await waitForLockWaiter(sql);
    const unrelated = await submit(app.api, wagerBody(free));

    // `free` was settled while the bet on `busy` is still queued behind the lock
    expect(unrelated.status).toBe(200);
    expect(await lockWaiters(sql)).toBe(1);

    await lock.release();
    expect((await blocked).status).toBe(200);
  });
});

describe('idempotency under races', () => {
  it('answers 409 when another wallet commits the same key while the request is in flight', async () => {
    const mine = await openWallet(app.api, '100.00');
    const other = await openWallet(app.api, '100.00');
    const bet = wagerBody(mine);

    // Someone else inserts the same key (on another wallet) and keeps it uncommitted.
    let commit!: () => void;
    const mayCommit = new Promise<void>((resolve) => (commit = resolve));
    let inserted!: () => void;
    const rowInserted = new Promise<void>((resolve) => (inserted = resolve));
    const competitor = inTransaction(db, async (tx) => {
      await insertTransaction(
        tx,
        { id: other.id, playerId: other.playerId, currency: other.balance.currency },
        { idempotencyKey: keyOf(bet), externalTransactionId: `other-${newId()}` },
      );
      inserted();
      await mayCommit;
    });
    await rowInserted;

    // Our request does not see that row yet, so it settles the bet and then
    // blocks on the unique index entry until the competitor decides.
    const request = submit(app.api, bet);
    await waitForLockWaiter(sql);
    commit();
    await competitor;
    const response = await request;

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // its whole database transaction was rolled back, including the outbox
    // rows it had already inserted (the flush writes them first)
    expect(await balanceOf(app.api, mine.id)).toBe('100.00');
    expect(await countTransactions(sql, mine.id)).toBe(1);
    expect(await sql(`select id from outbox_messages where aggregate_id = ?`, [mine.id])).toHaveLength(2); // the opening's
  });
});

describe('a wallet locked for too long', () => {
  let impatient: TestApp;

  beforeAll(async () => {
    // same application, only a much shorter lock timeout than the default
    impatient = await startApp((builder) =>
      builder.overrideProvider(UNIT_OF_WORK).useFactory({
        factory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 200 }),
        inject: [MikroORM],
      }),
    );
  });

  afterAll(async () => {
    await impatient.close();
  });

  it('answers 503 with Retry-After, and retrying the same request later is safe', async () => {
    const wallet = await openWallet(impatient.api, '100.00');
    const bet = wagerBody(wallet);
    const lock = await holdWalletLock(db, wallet.id);

    const response = await submit(impatient.api, bet).finally(() => lock.release());

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.body.error.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect(await countTransactions(sql, wallet.id)).toBe(1); // nothing but the OPENING

    const retry = await submit(impatient.api, bet);

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: 'PROCESSED', balance: money('90.00'), idempotentReplay: false });
  });
});
