import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { UNIT_OF_WORK } from '../../src/application/unit-of-work';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { WageringMetrics } from '../../src/infrastructure/observability/wagering-metrics';
import { keyOf, money, openWallet, submit, wagerBody } from '../support/api-fixtures';
import { startApp, type TestApp } from '../support/app';
import { holdWalletLock, setupTestDatabase } from '../support/database';
import { metricValue } from '../support/metrics';

let db: MikroORM;
let app: TestApp;

beforeAll(async () => {
  db = await setupTestDatabase();
  app = await startApp();
});

afterAll(async () => {
  await app.close();
  await db.close(true);
});

const scrape = async (target: TestApp = app) => {
  const response = await target.api.getText('/metrics');
  expect(response.status).toBe(200);
  return response.body;
};

describe('GET /metrics', () => {
  it('counts decisions by status, duplicates, conflicts and processing time', async () => {
    const before = await scrape();
    const wallet = await openWallet(app.api, '50.00');
    const accepted = wagerBody(wallet, { money: money('10.00') });

    await submit(app.api, accepted); // PROCESSED
    await submit(app.api, wagerBody(wallet, { money: money('999.00') })); // REJECTED
    await submit(app.api, accepted); // replay
    await submit(app.api, { ...accepted, money: money('11.00') }, keyOf(accepted)); // conflict

    const after = await scrape();
    const delta = (name: string, labels: Record<string, string> = {}) =>
      metricValue(after, name, labels) - metricValue(before, name, labels);
    const bets = { entrypoint: 'http', kind: 'BET' };
    expect(delta('wagering_transactions_total', { ...bets, status: 'PROCESSED' })).toBe(1);
    expect(delta('wagering_transactions_total', { ...bets, status: 'REJECTED' })).toBe(1);
    expect(delta('wagering_duplicates_total', { type: 'idempotency-key' })).toBe(1);
    expect(delta('wagering_idempotency_conflicts_total', { entrypoint: 'http' })).toBe(1);
    expect(delta('wagering_processing_duration_seconds_count', { entrypoint: 'http' })).toBe(3);
  });

  it('reads the outbox backlog and the DLQ depth when scraped', async () => {
    await openWallet(app.api, '10.00'); // two events nobody publishes: the relay is off in tests

    const metrics = await scrape();

    expect(metricValue(metrics, 'wagering_outbox_pending_messages')).toBeGreaterThanOrEqual(2);
    expect(metricValue(metrics, 'wagering_outbox_lag_seconds')).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(metricValue(metrics, 'wagering_dead_letter_queue_messages'))).toBe(true);
  });

  it('counts lock conflicts', async () => {
    const impatient = await startApp((builder) =>
      builder.overrideProvider(UNIT_OF_WORK).useFactory({
        factory: (orm: MikroORM, metrics: WageringMetrics) => new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 100, metrics }),
        inject: [MikroORM, WageringMetrics],
      }),
    );
    try {
      const wallet = await openWallet(impatient.api);
      const lock = await holdWalletLock(db, wallet.id);
      const response = await submit(impatient.api, wagerBody(wallet)).finally(() => lock.release());

      expect(response.status).toBe(503);
      expect(metricValue(await scrape(impatient), 'wagering_lock_conflicts_total', { reason: 'lock_timeout' })).toBe(1);
    } finally {
      await impatient.close();
    }
  });
});
