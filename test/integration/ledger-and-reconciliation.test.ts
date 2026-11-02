import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import type { WalletView } from '../../src/http/views';
import { balanceOf, inconsistentWallets, money, openWallet, submit, wagerBody } from '../support/api-fixtures';
import { startApp, type TestApp } from '../support/app';
import { inTransaction, setupTestDatabase, sqlFor, type Sql } from '../support/database';
import { metricValue } from '../support/metrics';

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

async function bet(wallet: WalletView, amount = '1.00'): Promise<void> {
  expect((await submit(app.api, wagerBody(wallet, { money: money(amount) }))).status).toBe(200);
}

const ledgerPage = (walletId: string, query = '') => app.api.get(`/wallets/${walletId}/ledger${query}`);

/**
 * Bypasses every trigger for one transaction, the way a careless manual fix
 * straight in the database would. Only possible as a superuser.
 */
function tamperWithBalance(walletId: string, delta: string): Promise<void> {
  return inTransaction(db, async (tx) => {
    await tx(`set local session_replication_role = replica`);
    await tx(`update wallets set balance = balance + ?::numeric where id = ?`, [delta, walletId]);
  });
}

describe('GET /wallets/:walletId/ledger', () => {
  it('pages through the statement oldest first, and the cursor survives new entries', async () => {
    const wallet = await openWallet(app.api, '100.00'); // version 1
    for (let i = 0; i < 6; i++) await bet(wallet); // versions 2 to 7

    const first = await ledgerPage(wallet.id, '?limit=3');
    expect(first.status).toBe(200);
    expect(first.body.entries.map((entry: { walletVersion: number }) => entry.walletVersion)).toEqual([1, 2, 3]);
    expect(first.body.entries[0]).toMatchObject({
      direction: 'CREDIT',
      money: money('100.00'),
      balanceBefore: money('0.00'),
      balanceAfter: money('100.00'),
    });

    await bet(wallet); // version 8 lands while the client is paging
    await bet(wallet); // version 9

    const second = await ledgerPage(wallet.id, `?limit=3&cursor=${first.body.nextCursor}`);
    const third = await ledgerPage(wallet.id, `?limit=3&cursor=${second.body.nextCursor}`);
    const versions = [...first.body.entries, ...second.body.entries, ...third.body.entries].map(
      (entry: { walletVersion: number }) => entry.walletVersion,
    );
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]); // nothing skipped, nothing repeated
    expect(third.body.nextCursor).toBeNull();
    expect(third.body.entries.at(-1).balanceAfter).toEqual(money('92.00'));
  });

  it('returns an empty statement for a wallet opened without balance', async () => {
    const wallet = await openWallet(app.api, '0.00');

    const page = await ledgerPage(wallet.id);

    expect(page.body).toEqual({ walletId: wallet.id, entries: [], nextCursor: null });
  });

  it.each(['0', '201', 'abc', '1.5', '-1'])('answers 400 to limit=%s', async (limit) => {
    const wallet = await openWallet(app.api);

    const page = await ledgerPage(wallet.id, `?limit=${limit}`);

    expect(page.status).toBe(400);
    expect(page.body.error.code).toBe('INVALID_PAYLOAD');
  });

  it('answers 400 to a cursor that was not issued for this wallet', async () => {
    const wallet = await openWallet(app.api);
    const other = await openWallet(app.api);
    await bet(other);
    await bet(other);
    const { body } = await ledgerPage(other.id, '?limit=1');

    expect((await ledgerPage(wallet.id, `?cursor=${body.nextCursor}`)).status).toBe(400);
    expect((await ledgerPage(wallet.id, '?cursor=not-a-cursor')).status).toBe(400);
  });

  it('answers 404 for an unknown wallet', async () => {
    expect((await ledgerPage(newId())).status).toBe(404);
    expect((await ledgerPage('not-a-uuid')).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('confirms a wallet whose balance is the sum of its ledger', async () => {
    const wallet = await openWallet(app.api, '100.00');
    const stake = wagerBody(wallet, { money: money('30.00') });
    await submit(app.api, stake);
    await submit(app.api, wagerBody(wallet, { kind: 'WIN', money: money('45.50'), referenceExternalTransactionId: stake.externalTransactionId }));
    await submit(app.api, wagerBody(wallet, { money: money('500.00') })); // rejected: no entry

    const response = await app.api.post(`/wallets/${wallet.id}/reconciliation`, {});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: money('115.50'),
      calculatedBalance: money('115.50'),
      difference: money('0.00'),
      consistent: true,
      checkedEntries: 3,
    });
  });

  it('reports a balance that no longer matches the ledger, counts it, and leaves it as found', async () => {
    const wallet = await openWallet(app.api, '100.00');
    const inconsistentBefore = metricValue(
      (await app.api.getText('/metrics')).body,
      'wagering_reconciliations_total',
      { result: 'inconsistent' },
    );
    await tamperWithBalance(wallet.id, '5.00');

    try {
      const response = await app.api.post(`/wallets/${wallet.id}/reconciliation`, {});

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        storedBalance: money('105.00'),
        calculatedBalance: money('100.00'),
        difference: money('5.00'),
        consistent: false,
        checkedEntries: 1,
      });
      const metrics = (await app.api.getText('/metrics')).body;
      expect(metricValue(metrics, 'wagering_reconciliations_total', { result: 'inconsistent' })).toBe(inconsistentBefore + 1);
      // nothing was silently "fixed"
      expect(await balanceOf(app.api, wallet.id)).toBe('105.00');
    } finally {
      await tamperWithBalance(wallet.id, '-5.00'); // put it back for the invariant check
    }
  });

  it('answers 404 for an unknown wallet', async () => {
    expect((await app.api.post(`/wallets/${newId()}/reconciliation`, {})).status).toBe(404);
  });
});
