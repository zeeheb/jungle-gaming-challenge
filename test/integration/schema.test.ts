import {
  CheckConstraintViolationException,
  ForeignKeyConstraintViolationException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import { inTransaction, setupTestDatabase, sqlFor, waitUntil, type Sql } from '../support/database';
import {
  insertEntry,
  insertTransaction,
  move,
  openWallet,
  type EntryRow,
  type WalletRow,
} from '../support/schema-fixtures';

let orm: MikroORM;
let sql: Sql;

beforeAll(async () => {
  orm = await setupTestDatabase();
  sql = sqlFor(orm);
});

afterAll(async () => {
  await orm.close(true);
});

async function walletState(wallet: WalletRow) {
  const [row] = await sql(
    `select w.balance, w.version,
            coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0) as ledger_balance,
            count(e.id) as entries
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ?
      group by w.id`,
    [wallet.id],
  );
  return {
    balance: String(row!.balance),
    version: Number(row!.version),
    ledgerBalance: Number(row!.ledger_balance).toFixed(2),
    entries: Number(row!.entries),
  };
}

const insertBareWallet = (playerId: string, currency = 'BRL', balance = '0', version = 1) =>
  sql(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, now(), now())`,
    [newId(), playerId, currency, balance, version],
  );

describe('wallets', () => {
  it('exist once per player and currency', async () => {
    const wallet = await openWallet(orm, '0');

    await expect(insertBareWallet(wallet.playerId)).rejects.toThrow(UniqueConstraintViolationException);
    await expect(insertBareWallet(wallet.playerId)).rejects.toThrow(/wallets_player_currency_key/);
    await insertBareWallet(wallet.playerId, 'USD');
  });

  it('never hold a negative balance', async () => {
    await expect(insertBareWallet(newId(), 'BRL', '-0.01')).rejects.toThrow(CheckConstraintViolationException);

    const wallet = await openWallet(orm, '10.00');
    await expect(
      sql(`update wallets set balance = -1, version = version + 1 where id = ?`, [wallet.id]),
    ).rejects.toThrow(/wallets_balance_check/);
  });

  it('only accept ISO-4217 shaped currencies', async () => {
    await expect(insertBareWallet(newId(), 'brl')).rejects.toThrow(/wallets_currency_check/);
  });

  it('keep their identity', async () => {
    const wallet = await openWallet(orm, '0');
    await expect(sql(`update wallets set currency = 'USD' where id = ?`, [wallet.id])).rejects.toThrow(
      /cannot change its identity/,
    );
  });

  it('move their version together with their balance, and only then', async () => {
    const wallet = await openWallet(orm, '100.00');

    await expect(sql(`update wallets set balance = 90 where id = ?`, [wallet.id])).rejects.toThrow(
      /without moving to version 2/,
    );
    await expect(sql(`update wallets set version = 2 where id = ?`, [wallet.id])).rejects.toThrow(
      /without changing its balance/,
    );
  });

  it('cannot change balance without a ledger entry, checked when the transaction commits', async () => {
    const wallet = await openWallet(orm, '100.00');

    await expect(
      inTransaction(orm, (tx) => tx(`update wallets set balance = 50, version = 2 where id = ?`, [wallet.id])),
    ).rejects.toThrow(/reached version 2 without a matching ledger entry/);
    expect(await walletState(wallet)).toMatchObject({ balance: '100.00', version: 1 });
  });

  it('cannot be opened with money the ledger does not explain', async () => {
    await expect(insertBareWallet(newId(), 'BRL', '50.00')).rejects.toThrow(/without a matching ledger entry/);
  });

  it('start at version 1', async () => {
    await expect(insertBareWallet(newId(), 'BRL', '0', 2)).rejects.toThrow(/must be created at version 1/);
  });

  it('are never deleted', async () => {
    const wallet = await openWallet(orm, '0');

    await expect(sql(`delete from wallets where id = ?`, [wallet.id])).rejects.toThrow(
      /DELETE on wallets is not allowed/,
    );
    await expect(sql(`truncate wallets cascade`)).rejects.toThrow(/TRUNCATE on wallets is not allowed/);
  });

  it('accept complete movements and stay equal to the sum of their ledger', async () => {
    const wallet = await openWallet(orm, '100.00');

    await move(orm, wallet, 'DEBIT', '30.00');
    await move(orm, wallet, 'CREDIT', '5.50');

    expect(await walletState(wallet)).toEqual({ balance: '75.50', version: 3, ledgerBalance: '75.50', entries: 3 });
  });

  it('opened empty start their ledger at version 2', async () => {
    const wallet = await openWallet(orm, '0');

    await move(orm, wallet, 'CREDIT', '20.00');

    expect(await walletState(wallet)).toEqual({ balance: '20.00', version: 2, ledgerBalance: '20.00', entries: 1 });
  });
});

describe('wallet_ledger_entries', () => {
  // A transaction row the entry can point to, inside the same database transaction.
  const entryFor = async (tx: Sql, wallet: WalletRow, entry: Omit<EntryRow, 'transactionId'>) => {
    const transactionId = await insertTransaction(tx, wallet, { kind: entry.direction === 'CREDIT' ? 'WIN' : 'BET' });
    return insertEntry(tx, wallet, { ...entry, transactionId });
  };

  it('are append-only', async () => {
    const wallet = await openWallet(orm, '100.00');

    await expect(sql(`update wallet_ledger_entries set amount = 1 where wallet_id = ?`, [wallet.id])).rejects.toThrow(
      /UPDATE on wallet_ledger_entries is not allowed/,
    );
    await expect(sql(`delete from wallet_ledger_entries where wallet_id = ?`, [wallet.id])).rejects.toThrow(
      /DELETE on wallet_ledger_entries is not allowed/,
    );
    await expect(sql(`truncate wallet_ledger_entries`)).rejects.toThrow(/TRUNCATE on wallet_ledger_entries/);
  });

  it('must add up: balance_before ± amount = balance_after', async () => {
    const wallet = await openWallet(orm, '100.00');

    await expect(
      inTransaction(orm, (tx) =>
        entryFor(tx, wallet, { version: 2, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '95.00' }),
      ),
    ).rejects.toThrow(/wallet_ledger_entries_balanced_check/);
  });

  it('move a positive amount', async () => {
    const wallet = await openWallet(orm, '100.00');

    await expect(
      inTransaction(orm, (tx) =>
        entryFor(tx, wallet, { version: 2, direction: 'CREDIT', amount: '0', before: '100.00', after: '100.00' }),
      ),
    ).rejects.toThrow(/wallet_ledger_entries_amount_check/);
  });

  it('are in the currency of their wallet', async () => {
    const wallet = await openWallet(orm, '100.00');

    await expect(
      inTransaction(orm, (tx) =>
        entryFor(tx, wallet, {
          version: 2,
          direction: 'CREDIT',
          amount: '1.00',
          before: '100.00',
          after: '101.00',
          currency: 'USD',
        }),
      ),
    ).rejects.toThrow(ForeignKeyConstraintViolationException);
  });

  it('belong to the wallet of their transaction', async () => {
    const owner = await openWallet(orm, '100.00');
    const other = await openWallet(orm, '100.00');
    const { transactionId } = await move(orm, owner, 'DEBIT', '1.00');

    await expect(
      inTransaction(orm, (tx) =>
        insertEntry(tx, other, {
          version: 2,
          transactionId,
          direction: 'DEBIT',
          amount: '1.00',
          before: '100.00',
          after: '99.00',
        }),
      ),
    ).rejects.toThrow(/wallet_ledger_entries_transaction_fkey/);
  });

  it('book a transaction at most once', async () => {
    const wallet = await openWallet(orm, '100.00');
    const { transactionId } = await move(orm, wallet, 'DEBIT', '10.00');

    await expect(
      inTransaction(orm, (tx) =>
        insertEntry(tx, wallet, {
          version: 3,
          transactionId,
          direction: 'DEBIT',
          amount: '10.00',
          before: '90.00',
          after: '80.00',
        }),
      ),
    ).rejects.toThrow(/wallet_ledger_entries_transaction_wallet_key/);
  });

  it('continue the previous entry', async () => {
    const wallet = await openWallet(orm, '100.00');

    await expect(
      inTransaction(orm, (tx) =>
        entryFor(tx, wallet, { version: 2, direction: 'DEBIT', amount: '10.00', before: '90.00', after: '80.00' }),
      ),
    ).rejects.toThrow(/does not continue entry version 1/);
    await expect(
      inTransaction(orm, (tx) =>
        entryFor(tx, wallet, { version: 3, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00' }),
      ),
    ).rejects.toThrow(/does not continue entry version 1/);
  });

  it('must be reflected in the wallet, checked when the transaction commits', async () => {
    const wallet = await openWallet(orm, '100.00');

    await expect(
      inTransaction(orm, (tx) =>
        entryFor(tx, wallet, { version: 2, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00' }),
      ),
    ).rejects.toThrow(/is not reflected in wallet/);
    expect(await walletState(wallet)).toMatchObject({ entries: 1, version: 1 });
  });

  it('stop a lost update even when the application forgets to lock the wallet', async () => {
    const wallet = await openWallet(orm, '100.00');

    // Both writers believe the wallet is at version 1 with 100.00 (nobody used
    // FOR UPDATE) and both write version 2. The first keeps its transaction
    // open until the second is stuck on the unique index, then commits.
    const debitFromVersion1 = (tx: Sql) =>
      insertTransaction(tx, wallet).then((transactionId) =>
        insertEntry(tx, wallet, {
          version: 2,
          transactionId,
          direction: 'DEBIT',
          amount: '10.00',
          before: '100.00',
          after: '90.00',
        }),
      );
    const someoneIsWaitingOnALock = async () => {
      const [row] = await sql(
        `select count(*) as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      return Number(row!.waiting) > 0;
    };

    let firstWrote!: () => void;
    const firstHasWritten = new Promise<void>((resolve) => (firstWrote = resolve));

    const first = inTransaction(orm, async (tx) => {
      await debitFromVersion1(tx);
      firstWrote();
      await waitUntil(someoneIsWaitingOnALock);
      await tx(`update wallets set balance = 90, version = 2 where id = ?`, [wallet.id]);
    });
    await firstHasWritten;
    const second = inTransaction(orm, async (tx) => {
      await debitFromVersion1(tx);
      await tx(`update wallets set balance = 90, version = 2 where id = ?`, [wallet.id]);
    });

    await first;
    const failure = await second.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UniqueConstraintViolationException);
    expect(String(failure)).toMatch(/wallet_ledger_entries_wallet_version_key/);
    expect(await walletState(wallet)).toEqual({ balance: '90.00', version: 2, ledgerBalance: '90.00', entries: 2 });
  });
});

describe('wager_transactions', () => {
  let wallet: WalletRow;

  beforeAll(async () => {
    wallet = await openWallet(orm, '1000.00');
  });

  const insert = (row: Parameters<typeof insertTransaction>[2]) => insertTransaction(sql, wallet, row);

  it('identify a provider transaction once', async () => {
    const externalTransactionId = newId();
    await insert({ externalTransactionId });

    await expect(insert({ externalTransactionId, idempotencyKey: newId() })).rejects.toThrow(
      /wager_transactions_provider_external_key/,
    );
    await insert({ externalTransactionId, providerId: 'provider-b' });
  });

  it('scope the idempotency key to the provider', async () => {
    const idempotencyKey = newId();
    await insert({ idempotencyKey });

    await expect(insert({ idempotencyKey })).rejects.toThrow(/wager_transactions_provider_idempotency_key/);
    await insert({ idempotencyKey, providerId: 'provider-b' });
  });

  it('require a reference for REFUND and ROLLBACK and forbid one on BET', async () => {
    await expect(insert({ kind: 'REFUND' })).rejects.toThrow(/wager_transactions_reference_check/);
    await expect(insert({ kind: 'ROLLBACK' })).rejects.toThrow(/wager_transactions_reference_check/);
    await expect(insert({ kind: 'BET', referenceExternalTransactionId: 'x' })).rejects.toThrow(
      /wager_transactions_reference_check/,
    );
    await insert({ kind: 'WIN', referenceExternalTransactionId: 'x' });
  });

  it('accept a zero amount only for LOSS', async () => {
    await expect(insert({ amount: '0' })).rejects.toThrow(/wager_transactions_amount_check/);
    await expect(insert({ amount: '-1.00' })).rejects.toThrow(/wager_transactions_amount_check/);
    await insert({ kind: 'LOSS', amount: '0' });
  });

  it('keep OPENING internal', async () => {
    await expect(insert({ kind: 'OPENING' })).rejects.toThrow(/wager_transactions_opening_check/);
    await expect(insert({ providerId: 'internal' })).rejects.toThrow(/wager_transactions_opening_check/);
  });

  it('record a coherent outcome', async () => {
    await expect(insert({ status: 'REJECTED', failureCode: null })).rejects.toThrow(
      /wager_transactions_failure_code_check/,
    );
    await expect(insert({ status: 'PROCESSED', failureCode: 'INSUFFICIENT_FUNDS' })).rejects.toThrow(
      /wager_transactions_failure_code_check/,
    );
    await expect(insert({ status: 'PROCESSED', resultingBalance: null })).rejects.toThrow(
      /wager_transactions_outcome_balance_check/,
    );
    await expect(
      insert({ kind: 'REFUND', referenceExternalTransactionId: 'x', status: 'PENDING_REFERENCE', nextReferenceAttemptAt: null }),
    ).rejects.toThrow(/wager_transactions_pending_reference_check/);
  });

  it('revert a transaction at most once, whatever the kind of reversal', async () => {
    const bet = await insert({ status: 'PROCESSED' });
    const reversal = (kind: string, status: string) =>
      insert({ kind, status, referenceExternalTransactionId: `ext-${bet}`, referenceTransactionId: bet });

    await reversal('REFUND', 'PROCESSED');

    await expect(reversal('ROLLBACK', 'PROCESSED')).rejects.toThrow(/wager_transactions_single_reversal_idx/);
    await expect(reversal('REFUND', 'PROCESSED')).rejects.toThrow(/wager_transactions_single_reversal_idx/);
    // a rejected attempt is history, not a reversal
    await reversal('ROLLBACK', 'REJECTED');
  });

  it('are frozen once terminal', async () => {
    for (const status of ['PROCESSED', 'REJECTED', 'FAILED']) {
      const id = await insert({ status });
      await expect(sql(`update wager_transactions set reference_attempts = 1 where id = ?`, [id])).rejects.toThrow(
        new RegExp(`is ${status} and cannot change`),
      );
    }
  });

  it('may reach an outcome from pending, but never go back nor change business fields', async () => {
    const waiting = () =>
      insert({ kind: 'REFUND', referenceExternalTransactionId: 'late-bet', status: 'PENDING_REFERENCE' });

    const rejected = await waiting();
    await sql(
      `update wager_transactions
          set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', processed_at = now(),
              resulting_balance = 0, resulting_balance_currency = 'BRL', next_reference_attempt_at = null
        where id = ?`,
      [rejected],
    );

    const other = await waiting();
    await expect(sql(`update wager_transactions set amount = 999 where id = ?`, [other])).rejects.toThrow(
      /business fields are immutable/,
    );
    await expect(sql(`update wager_transactions set status = 'PENDING' where id = ?`, [other])).rejects.toThrow(
      /cannot go back to PENDING/,
    );
  });

  it('are never deleted', async () => {
    const id = await insert({});
    await expect(sql(`delete from wager_transactions where id = ?`, [id])).rejects.toThrow(
      /DELETE on wager_transactions is not allowed/,
    );
  });
});

describe('inbox and outbox', () => {
  const receive = (consumer: string, messageId: string) =>
    sql(`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, now())`, [
      consumer,
      messageId,
      'a'.repeat(64),
    ]);

  it('inbox remembers a message once per consumer', async () => {
    const messageId = newId();
    await receive('wager-transactions', messageId);

    await expect(receive('wager-transactions', messageId)).rejects.toThrow(/inbox_messages_pkey/);
    await receive('another-consumer', messageId);
  });

  it('outbox keeps every unpublished message scheduled', async () => {
    await expect(
      sql(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
         values (?, 'wallet', 'WalletBalanceChanged', '{}', now())`,
        [newId()],
      ),
    ).rejects.toThrow(/outbox_messages_schedule_check/);
  });
});
