import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import { inconsistentWallets, ledgerOf, money, openWallet } from '../support/api-fixtures';
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

const newPlayer = () => `player-${newId()}`;

describe('POST /wallets', () => {
  it('opens the wallet and books the initial balance as an OPENING credit, all in one transaction', async () => {
    const playerId = newPlayer();
    const response = await app.api.post('/wallets', { playerId, initialBalance: money('1000.00') });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ playerId, balance: money('1000.00'), version: 1 });

    const walletId: string = response.body.id;
    expect(await sql(`select kind, provider_id, status, amount from wager_transactions where wallet_id = ?`, [walletId])).toEqual([
      { kind: 'OPENING', provider_id: 'internal', status: 'PROCESSED', amount: '1000.00' },
    ]);
    expect(await ledgerOf(sql, walletId)).toEqual([
      { version: 1, direction: 'CREDIT', amount: '1000.00', balanceAfter: '1000.00' },
    ]);
    expect(await sql(`select event_type from outbox_messages where aggregate_id = ? order by event_type`, [walletId])).toEqual([
      { event_type: 'WagerTransactionProcessed' },
      { event_type: 'WalletBalanceChanged' },
    ]);
  });

  it('opens an empty wallet at version 1 without transaction, ledger entry or event', async () => {
    const wallet = await openWallet(app.api, '0.00');

    expect(wallet).toMatchObject({ balance: money('0.00'), version: 1 });
    expect(await sql(`select id from wager_transactions where wallet_id = ?`, [wallet.id])).toEqual([]);
    expect(await ledgerOf(sql, wallet.id)).toEqual([]);
    expect(await sql(`select id from outbox_messages where aggregate_id = ?`, [wallet.id])).toEqual([]);
  });

  it('answers 409 to a second wallet in the same currency, but accepts another currency', async () => {
    const playerId = newPlayer();
    await app.api.post('/wallets', { playerId, initialBalance: money('10.00') });

    const duplicate = await app.api.post('/wallets', { playerId, initialBalance: money('99.00') });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('WALLET_ALREADY_EXISTS');

    const otherCurrency = await app.api.post('/wallets', { playerId, initialBalance: money('10.00', 'USD') });
    expect(otherCurrency.status).toBe(201);
  });

  it('lets exactly one of many concurrent requests open the same wallet', async () => {
    const playerId = newPlayer();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => app.api.post('/wallets', { playerId, initialBalance: money('50.00') })),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, ...Array<number>(9).fill(409)]);
    const rows = await sql(`select id from wallets where player_id = ?`, [playerId]);
    expect(rows).toHaveLength(1);
    expect(await ledgerOf(sql, rows[0]!['id'] as string)).toHaveLength(1);
  });

  it('keeps the caller X-Correlation-Id in the response and in the events', async () => {
    const response = await app.api.post(
      '/wallets',
      { playerId: newPlayer(), initialBalance: money('5.00') },
      { 'X-Correlation-Id': 'correlation-123' },
    );

    expect(response.headers.get('x-correlation-id')).toBe('correlation-123');
    const events = await sql(`select payload ->> 'correlationId' as correlation_id from outbox_messages where aggregate_id = ?`, [
      response.body.id,
    ]);
    expect(events).toEqual([{ correlation_id: 'correlation-123' }, { correlation_id: 'correlation-123' }]);
  });

  it.each([
    ['no playerId', { initialBalance: money('1.00') }],
    ['a blank playerId', { playerId: '  ', initialBalance: money('1.00') }],
    ['no initial balance', { playerId: 'p' }],
    ['three decimal places', { playerId: 'p', initialBalance: money('1.005') }],
    ['a negative amount', { playerId: 'p', initialBalance: money('-1.00') }],
    ['scientific notation', { playerId: 'p', initialBalance: money('1e3') }],
    ['an amount sent as a number', { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }],
    ['a lowercase currency', { playerId: 'p', initialBalance: money('1.00', 'brl') }],
    ['an array instead of an object', []],
  ])('answers 400 INVALID_PAYLOAD to %s', async (_, body) => {
    const response = await app.api.post('/wallets', body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('GET /wallets/:walletId', () => {
  it('returns the current balance and version', async () => {
    const wallet = await openWallet(app.api, '42.50');

    const response = await app.api.get(`/wallets/${wallet.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(wallet);
  });

  it.each([
    ['an unknown id', newId()],
    ['a malformed id', 'not-a-uuid'],
  ])('answers 404 WALLET_NOT_FOUND to %s', async (_, walletId) => {
    const response = await app.api.get(`/wallets/${walletId}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});
