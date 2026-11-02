import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { UnitOfWork } from '../../src/application/unit-of-work';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { RetryPendingReferences } from '../../src/application/wagering/retry-pending-references';
import { parseWagerRequest } from '../../src/application/wagering/wager-request';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { walletView, type WalletView } from '../../src/http/views';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { inconsistentWallets, keyOf, ledgerOf, money, wagerBody, type WagerBody } from '../support/api-fixtures';
import { holdWalletLock, setupTestDatabase, sqlFor, type Row, type Sql } from '../support/database';

// Time is driven by passing the scheduled time to runOnce(now): the whole
// retry budget (~8.5 minutes) runs in milliseconds, and nothing sleeps.

let db: MikroORM;
let sql: Sql;
let unitOfWork: UnitOfWork;
let worker: RetryPendingReferences;

beforeAll(async () => {
  db = await setupTestDatabase();
  sql = sqlFor(db);
  unitOfWork = new MikroOrmUnitOfWork(db, { lockTimeoutMs: 5_000 });
  worker = new RetryPendingReferences(unitOfWork, 20);
});

afterEach(async () => {
  expect(await inconsistentWallets(sql)).toEqual([]);
});

afterAll(async () => {
  await db.close(true);
});

async function openWallet(amount = '100.00'): Promise<WalletView> {
  const wallet = await new OpenWallet(unitOfWork).execute({
    playerId: `player-${newId()}`,
    initialBalance: Money.from(money(amount)),
    correlationId: 'test',
  });
  return walletView(wallet);
}

/** Submits through the same use case as HTTP and SQS. */
function submit(body: WagerBody, correlationId = 'test') {
  return new ProcessWagerTransaction(unitOfWork).execute({
    idempotencyKey: keyOf(body),
    payload: parseWagerRequest(body),
    correlationId,
  });
}

async function stored(body: WagerBody): Promise<Row> {
  const [row] = await sql(
    `select id, status, failure_code, reference_transaction_id, reference_attempts, next_reference_attempt_at,
            created_at, processed_at
       from wager_transactions where provider_id = ? and external_transaction_id = ?`,
    [body.providerId, body.externalTransactionId],
  );
  return row!;
}

/** When the worker is next supposed to look at this transaction. */
const dueTimeOf = async (body: WagerBody) => new Date((await stored(body))['next_reference_attempt_at'] as string);

async function balanceOf(wallet: WalletView): Promise<string> {
  const [row] = await sql(`select balance from wallets where id = ?`, [wallet.id]);
  return row!['balance'] as string;
}

async function eventsOf(transactionId: unknown) {
  return sql(
    `select event_type, payload ->> 'correlationId' as correlation_id from outbox_messages
      where payload -> 'data' ->> 'transactionId' = ? order by occurred_at, event_type`,
    [transactionId],
  );
}

describe('pending references', () => {
  it.each(['REFUND', 'ROLLBACK'])('a %s delivered before its BET is settled once the BET arrives', async (kind) => {
    const wallet = await openWallet('100.00');
    const bet = wagerBody(wallet, { money: money('30.00') });
    const reversal = wagerBody(wallet, { kind, money: money('30.00'), referenceExternalTransactionId: bet.externalTransactionId });

    expect((await submit(reversal, 'corr-reversal')).transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect((await submit(bet)).transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet)).toBe('70.00');

    await worker.runOnce(await dueTimeOf(reversal));

    expect(await stored(reversal)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: (await stored(bet))['id'],
      reference_attempts: 1,
    });
    expect(await balanceOf(wallet)).toBe('100.00');
    // the later events keep the trace of the request that created the transaction
    expect(await eventsOf((await stored(reversal))['id'])).toEqual([
      { event_type: 'WagerTransactionPendingReference', correlation_id: 'corr-reversal' },
      { event_type: 'WagerTransactionProcessed', correlation_id: 'corr-reversal' },
      { event_type: 'WalletBalanceChanged', correlation_id: 'corr-reversal' },
    ]);
    // a replay now answers with the final outcome
    expect(await submit(reversal)).toMatchObject({ replay: true, transaction: { status: 'PROCESSED' } });
  });

  it('keeps waiting with exponential backoff, announcing the wait only once', async () => {
    const wallet = await openWallet();
    const refund = wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: `never-sent-${newId()}` });
    await submit(refund);

    const delays: number[] = [];
    for (let round = 0; round < 3; round++) {
      const due = await dueTimeOf(refund);
      await worker.runOnce(due);
      delays.push((await dueTimeOf(refund)).getTime() - due.getTime());
    }

    expect(delays).toEqual([2_000, 4_000, 8_000]);
    expect(await stored(refund)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 4 });
    expect((await eventsOf((await stored(refund))['id'])).map((event) => event['event_type'])).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  it('gives up after the 10th lookup (~8.5 minutes): REJECTED with REFERENCE_NOT_FOUND, and says so', async () => {
    const wallet = await openWallet('100.00');
    const refund = wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: `never-sent-${newId()}` });
    await submit(refund);

    let rounds = 0;
    while ((await stored(refund))['status'] === 'PENDING_REFERENCE') {
      await worker.runOnce(await dueTimeOf(refund));
      rounds += 1;
    }

    const row = await stored(refund);
    expect(rounds).toBe(9); // lookups 2 to 10; the first was on arrival
    expect(row).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_attempts: 10 });
    // 1 + 2 + 4 + ... + 256 seconds between the first lookup and the last one
    expect(new Date(row['processed_at'] as string).getTime() - new Date(row['created_at'] as string).getTime()).toBe(511_000);
    expect((await eventsOf(row['id'])).map((event) => event['event_type'])).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(await ledgerOf(sql, wallet.id)).toHaveLength(1);
  });

  it('resolves a chain in one round: a ROLLBACK of a REFUND of a BET that came last', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerBody(wallet);
    const refund = wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    const rollback = wagerBody(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: refund.externalTransactionId });
    await submit(refund);
    await submit(rollback); // its reference exists but is not final yet: it waits too
    await submit(bet);

    await worker.runOnce(await dueTimeOf(rollback));

    expect((await stored(refund))['status']).toBe('PROCESSED');
    expect((await stored(rollback))['status']).toBe('PROCESSED');
    expect(await balanceOf(wallet)).toBe('90.00'); // 100 - 10 (bet) + 10 (refund) - 10 (rollback of the refund)
  });

  it('rejects the second of two waiting REFUNDs of the same BET as REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerBody(wallet);
    const first = wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    const second = wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    await submit(first);
    await submit(second);
    await submit(bet);

    await worker.runOnce(await dueTimeOf(second));

    expect((await stored(first))['status']).toBe('PROCESSED');
    expect(await stored(second)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_ALREADY_REVERSED' });
    expect(await balanceOf(wallet)).toBe('100.00');
  });
});

describe('several workers', () => {
  it('settle each pending transaction exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet('100.00')));
    const refunds: WagerBody[] = [];
    for (const wallet of wallets) {
      const bet = wagerBody(wallet);
      const refund = wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
      await submit(refund);
      await submit(bet);
      refunds.push(refund);
    }
    const now = new Date(Math.max(...(await Promise.all(refunds.map(dueTimeOf))).map((due) => due.getTime())));

    // three instances, each with its own worker, all looking at the same rows
    const rounds = await Promise.all(
      Array.from({ length: 3 }, () => new RetryPendingReferences(unitOfWork, 20).runOnce(now)),
    );

    for (const [index, wallet] of wallets.entries()) {
      expect((await stored(refunds[index]!))['status']).toBe('PROCESSED');
      expect(await balanceOf(wallet)).toBe('100.00');
      expect((await ledgerOf(sql, wallet.id)).map((entry) => entry['direction'])).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
    }
    // whoever lost the race for a row found it already settled
    expect(rounds.reduce((sum, round) => sum + round.settled, 0)).toBeGreaterThanOrEqual(10);
    expect(rounds.reduce((sum, round) => sum + round.skipped, 0)).toBe(
      rounds.reduce((sum, round) => sum + round.due, 0) - rounds.reduce((sum, round) => sum + round.settled + round.waiting, 0),
    );
  });

  it('leave a wallet that stays locked for the next round', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerBody(wallet);
    const refund = wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    await submit(refund);
    await submit(bet);
    const now = await dueTimeOf(refund);
    const impatient = new RetryPendingReferences(new MikroOrmUnitOfWork(db, { lockTimeoutMs: 100 }), 20);
    const lock = await holdWalletLock(db, wallet.id);

    const blocked = await impatient.runOnce(now).finally(() => lock.release());

    expect(blocked.busy).toBeGreaterThanOrEqual(1);
    expect((await stored(refund))['status']).toBe('PENDING_REFERENCE');

    await impatient.runOnce(now);
    expect((await stored(refund))['status']).toBe('PROCESSED');
  });
});
