import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import type { WalletView } from '../../src/http/views';
import {
  balanceOf,
  countTransactions,
  eventsOf,
  inconsistentWallets,
  keyOf,
  ledgerOf,
  money,
  openWallet,
  submit,
  wagerBody,
  type WagerBody,
} from '../support/api-fixtures';
import { startApp, type TestApp } from '../support/app';
import { setupTestDatabase, sqlFor, type Sql } from '../support/database';

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

/** Submits and asserts the HTTP status in one go; returns the body. */
async function expectSubmission(body: WagerBody, status: number, idempotencyKey = keyOf(body)) {
  const response = await submit(app.api, body, idempotencyKey);
  expect({ status: response.status, body: response.body }).toMatchObject({ status });
  return response.body;
}

describe('BET', () => {
  it('debits the wallet and answers 200 PROCESSED with the resulting balance', async () => {
    const wallet = await openWallet(app.api, '100.00');

    const body = await expectSubmission(wagerBody(wallet, { money: money('25.00') }), 200);

    expect(body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: money('75.00'),
      idempotentReplay: false,
    });
    expect((await app.api.get(`/wallets/${wallet.id}`)).body).toMatchObject({ balance: money('75.00'), version: 2 });
    expect((await ledgerOf(sql, wallet.id)).at(-1)).toEqual({
      version: 2,
      direction: 'DEBIT',
      amount: '25.00',
      balanceAfter: '75.00',
    });
    expect(await eventsOf(sql, body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('answers 422 INSUFFICIENT_FUNDS to a bet larger than the balance, without touching the ledger', async () => {
    const wallet = await openWallet(app.api, '5.00');

    const body = await expectSubmission(wagerBody(wallet), 422);

    expect(body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: money('5.00'),
      idempotentReplay: false,
    });
    expect(await ledgerOf(sql, wallet.id)).toHaveLength(1);
    expect(await eventsOf(sql, body.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  it('answers 422 CURRENCY_MISMATCH to a bet in another currency', async () => {
    const wallet = await openWallet(app.api, '100.00');

    const body = await expectSubmission(wagerBody(wallet, { money: money('10.00', 'USD') }), 422);

    expect(body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(await balanceOf(app.api, wallet.id)).toBe('100.00');
  });

  it("answers 422 WALLET_PLAYER_MISMATCH to a bet on someone else's wallet", async () => {
    const wallet = await openWallet(app.api, '100.00');

    const body = await expectSubmission(wagerBody(wallet, { playerId: 'someone-else' }), 422);

    expect(body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    expect(await balanceOf(app.api, wallet.id)).toBe('100.00');
  });

  it('answers 404 WALLET_NOT_FOUND for a wallet that does not exist, and stores nothing', async () => {
    const wallet = await openWallet(app.api);
    const bet = wagerBody({ ...wallet, id: newId() });

    const response = await submit(app.api, bet);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
    expect((await app.api.get(`/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`)).status).toBe(404);
  });
});

describe('idempotency', () => {
  let wallet: WalletView;

  beforeAll(async () => {
    wallet = await openWallet(app.api, '100.00');
  });

  it('replays the original outcome, including the balance seen back then', async () => {
    const first = wagerBody(wallet);
    const original = await expectSubmission(first, 200);
    await expectSubmission(wagerBody(wallet), 200); // the balance moves on

    const replay = await expectSubmission(first, 200);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(await countTransactions(sql, wallet.id)).toBe(3); // OPENING + 2 bets
  });

  it('replays a rejection as a rejection', async () => {
    const tooBig = wagerBody(wallet, { money: money('5000.00') });
    const original = await expectSubmission(tooBig, 422);

    const replay = await expectSubmission(tooBig, 422);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
  });

  it('treats the same content written differently (amount "10", other key order) as the same request', async () => {
    const first = wagerBody(wallet, { money: money('10.00') });
    const original = await expectSubmission(first, 200);
    const { money: _, ...rest } = first;
    const rewritten = { money: { currency: 'BRL', amount: '10' }, ...Object.fromEntries(Object.entries(rest).reverse()) };

    const replay = await expectSubmission(rewritten as WagerBody, 200, keyOf(first));

    expect(replay).toEqual({ ...original, idempotentReplay: true });
  });

  it('answers 409 IDEMPOTENCY_CONFLICT to the same key with another payload, and changes nothing', async () => {
    const first = wagerBody(wallet);
    await expectSubmission(first, 200);
    const balance = await balanceOf(app.api, wallet.id);
    const transactions = await countTransactions(sql, wallet.id);

    const response = await submit(app.api, { ...first, money: money('11.00') }, keyOf(first));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await balanceOf(app.api, wallet.id)).toBe(balance);
    expect(await countTransactions(sql, wallet.id)).toBe(transactions);
  });

  it('answers 409 IDEMPOTENCY_CONFLICT to an externalTransactionId reused under another key', async () => {
    const first = wagerBody(wallet);
    await expectSubmission(first, 200);

    const response = await submit(app.api, first, `${keyOf(first)}:retry`);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('scopes keys by provider: two providers may use the same key', async () => {
    const fromA = wagerBody(wallet, { providerId: 'provider-a' });
    const fromB = wagerBody(wallet, { providerId: 'provider-b' });

    const [a, b] = [await expectSubmission(fromA, 200, 'shared-key'), await expectSubmission(fromB, 200, 'shared-key')];

    expect(a.transactionId).not.toBe(b.transactionId);
    expect([a.idempotentReplay, b.idempotentReplay]).toEqual([false, false]);
  });
});

describe('invalid submissions', () => {
  let wallet: WalletView;

  beforeAll(async () => {
    wallet = await openWallet(app.api, '100.00');
  });

  it('answers 400 when the Idempotency-Key header is missing', async () => {
    const response = await app.api.post('/wagering/transactions', wagerBody(wallet));

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({ code: 'INVALID_PAYLOAD', message: 'Idempotency-Key is required' });
  });

  it('answers 400 to a body that is not valid JSON', async () => {
    const response = await app.api.postRaw('/wagering/transactions', '{"kind": "BET",', { 'Idempotency-Key': 'k' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_PAYLOAD');
  });

  it.each<[string, Partial<WagerBody> | Record<string, unknown>]>([
    ['the internal OPENING kind', { kind: 'OPENING' }],
    ['an unknown kind', { kind: 'JACKPOT' }],
    ['three decimal places', { money: money('10.005') }],
    ['a zero BET', { money: money('0.00') }],
    ['a walletId that is not a UUID', { walletId: 'wallet-1' }],
    ['a REFUND without reference', { kind: 'REFUND' }],
    ['a BET with a reference', { referenceExternalTransactionId: 'ext-other' }],
    ['the reserved provider "internal"', { providerId: 'internal' }],
    ['a missing roundId', { roundId: undefined }],
  ])('answers 400 INVALID_PAYLOAD to %s and stores nothing', async (_, overrides) => {
    const body = { ...wagerBody(wallet), ...overrides };
    const before = await countTransactions(sql, wallet.id);

    const response = await submit(app.api, body, `key-${newId()}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_PAYLOAD');
    expect(await countTransactions(sql, wallet.id)).toBe(before);
  });
});

describe('a round from BET to settlement', () => {
  it('WIN credits the wallet and points to its BET', async () => {
    const wallet = await openWallet(app.api, '100.00');
    const bet = wagerBody(wallet, { money: money('10.00') });
    const betResult = await expectSubmission(bet, 200);

    const win = await expectSubmission(
      wagerBody(wallet, { kind: 'WIN', money: money('25.00'), referenceExternalTransactionId: bet.externalTransactionId }),
      200,
    );

    expect(win.balance).toEqual(money('115.00'));
    const stored = await app.api.get(`/wagering/transactions/${win.transactionId}`);
    expect(stored.body).toMatchObject({ kind: 'WIN', status: 'PROCESSED', referenceTransactionId: betResult.transactionId });
  });

  it('LOSS records the result without touching balance, version or ledger', async () => {
    const wallet = await openWallet(app.api, '100.00');
    const bet = wagerBody(wallet);
    await expectSubmission(bet, 200);

    const loss = await expectSubmission(
      wagerBody(wallet, { kind: 'LOSS', money: money('0.00'), referenceExternalTransactionId: bet.externalTransactionId }),
      200,
    );

    expect(loss).toMatchObject({ status: 'PROCESSED', balance: money('90.00') });
    expect((await app.api.get(`/wallets/${wallet.id}`)).body.version).toBe(2);
    expect(await ledgerOf(sql, wallet.id)).toHaveLength(2);
    expect(await eventsOf(sql, loss.transactionId)).toEqual(['WagerTransactionProcessed']);
  });

  it('REFUND gives the stake back once; any later reversal of that BET is rejected', async () => {
    const wallet = await openWallet(app.api, '100.00');
    const bet = wagerBody(wallet);
    await expectSubmission(bet, 200);
    const reversal = (kind: string) =>
      wagerBody(wallet, { kind, referenceExternalTransactionId: bet.externalTransactionId });

    expect((await expectSubmission(reversal('REFUND'), 200)).balance).toEqual(money('100.00'));
    expect((await expectSubmission(reversal('REFUND'), 422)).failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect((await expectSubmission(reversal('ROLLBACK'), 422)).failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(app.api, wallet.id)).toBe('100.00');
  });

  it('ROLLBACK of a BET credits the stake back', async () => {
    const wallet = await openWallet(app.api, '100.00');
    const bet = wagerBody(wallet, { money: money('30.00') });
    await expectSubmission(bet, 200);

    const rollback = await expectSubmission(
      wagerBody(wallet, { kind: 'ROLLBACK', money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId }),
      200,
    );

    expect(rollback.balance).toEqual(money('100.00'));
    expect((await ledgerOf(sql, wallet.id)).at(-1)).toMatchObject({ direction: 'CREDIT', amount: '30.00' });
  });

  it('ROLLBACK of a WIN that was already spent is rejected with REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await openWallet(app.api, '10.00');
    const bet = wagerBody(wallet, { money: money('10.00') });
    await expectSubmission(bet, 200);
    const win = wagerBody(wallet, { kind: 'WIN', money: money('50.00'), referenceExternalTransactionId: bet.externalTransactionId });
    await expectSubmission(win, 200);
    await expectSubmission(wagerBody(wallet, { roundId: 'round-2', money: money('50.00') }), 200); // spent

    const rollback = await expectSubmission(
      wagerBody(wallet, { kind: 'ROLLBACK', money: money('50.00'), referenceExternalTransactionId: win.externalTransactionId }),
      422,
    );

    expect(rollback).toMatchObject({ failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: money('0.00') });
  });

  it('REFUND of another amount is rejected with REFERENCE_AMOUNT_MISMATCH', async () => {
    const wallet = await openWallet(app.api, '100.00');
    const bet = wagerBody(wallet, { money: money('10.00') });
    await expectSubmission(bet, 200);

    const refund = await expectSubmission(
      wagerBody(wallet, { kind: 'REFUND', money: money('5.00'), referenceExternalTransactionId: bet.externalTransactionId }),
      422,
    );

    expect(refund.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
  });

  it('a REFUND that arrives before its BET waits as PENDING_REFERENCE (202) and moves no money', async () => {
    const wallet = await openWallet(app.api, '100.00');
    const lateBet = wagerBody(wallet);
    const refund = wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: lateBet.externalTransactionId });

    const accepted = await expectSubmission(refund, 202);

    expect(accepted).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect(await expectSubmission(refund, 202)).toEqual({ ...accepted, idempotentReplay: true });
    expect(await eventsOf(sql, accepted.transactionId)).toEqual(['WagerTransactionPendingReference']);
    const stored = await app.api.get(`/wagering/transactions/${accepted.transactionId}`);
    expect(stored.body).toMatchObject({ status: 'PENDING_REFERENCE', referenceAttempts: 1 });
    expect(stored.body.nextReferenceAttemptAt).toEqual(expect.any(String));
    expect(await balanceOf(app.api, wallet.id)).toBe('100.00');

    // the BET itself is processed normally; picking the REFUND up again is the worker's job
    await expectSubmission(lateBet, 200);
  });
});

describe('GET transactions', () => {
  it('finds a transaction by id and by provider + externalTransactionId', async () => {
    const wallet = await openWallet(app.api, '100.00');
    const bet = wagerBody(wallet);
    const { transactionId } = await expectSubmission(bet, 200);

    const byId = await app.api.get(`/wagering/transactions/${transactionId}`);
    const byExternalId = await app.api.get(`/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`);

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId,
      providerId: 'provider-a',
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: keyOf(bet),
      walletId: wallet.id,
      kind: 'BET',
      money: money('10.00'),
      status: 'PROCESSED',
      resultingBalance: money('90.00'),
    });
    expect(byExternalId.body).toEqual(byId.body);
    // external ids belong to their provider
    expect((await app.api.get(`/providers/provider-z/wagering/transactions/${bet.externalTransactionId}`)).status).toBe(404);
  });

  it.each([
    ['an unknown id', `/wagering/transactions/${newId()}`],
    ['a malformed id', '/wagering/transactions/not-a-uuid'],
    ['an unknown external id', '/providers/provider-a/wagering/transactions/nope'],
  ])('answers 404 TRANSACTION_NOT_FOUND to %s', async (_, path) => {
    const response = await app.api.get(path);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('TRANSACTION_NOT_FOUND');
  });
});
