import type { MikroORM } from '@mikro-orm/postgresql';
import { createHash } from 'node:crypto';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { inTransaction, type Sql } from './database';

// Raw-SQL fixtures: the schema tests exercise the database on its own,
// without the repositories that will sit on top of it.

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
}

export const fakeHash = (seed: string = newId()) => createHash('sha256').update(seed).digest('hex');

export interface TransactionRow {
  id?: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  kind?: string;
  amount?: string;
  currency?: string;
  status?: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  resultingBalance?: string | null;
  nextReferenceAttemptAt?: Date | null;
  roundId?: string;
}

const TERMINAL = ['PROCESSED', 'REJECTED', 'FAILED'];

export async function insertTransaction(sql: Sql, wallet: WalletRow, row: TransactionRow = {}): Promise<string> {
  const id = row.id ?? newId();
  const providerId = row.providerId ?? 'provider-a';
  const externalTransactionId = row.externalTransactionId ?? `ext-${id}`;
  const status = row.status ?? 'PENDING';
  const resultingBalance =
    row.resultingBalance !== undefined ? row.resultingBalance : ['PROCESSED', 'REJECTED'].includes(status) ? '0.00' : null;

  await sql(
    `insert into wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
       game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status,
       failure_code, resulting_balance, resulting_balance_currency, next_reference_attempt_at, created_at, processed_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?)`,
    [
      id,
      providerId,
      externalTransactionId,
      row.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
      fakeHash(),
      wallet.id,
      wallet.playerId,
      row.roundId ?? 'round-1',
      'fortune-chimp',
      row.kind ?? 'BET',
      row.amount ?? '10.00',
      row.currency ?? wallet.currency,
      row.referenceExternalTransactionId ?? null,
      row.referenceTransactionId ?? null,
      status,
      row.failureCode !== undefined ? row.failureCode : ['REJECTED', 'FAILED'].includes(status) ? 'INSUFFICIENT_FUNDS' : null,
      resultingBalance,
      resultingBalance === null ? null : wallet.currency,
      row.nextReferenceAttemptAt !== undefined ? row.nextReferenceAttemptAt : status === 'PENDING_REFERENCE' ? new Date() : null,
      TERMINAL.includes(status) ? new Date() : null,
    ],
  );
  return id;
}

export interface EntryRow {
  version: number;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  before: string;
  after: string;
  currency?: string;
  walletId?: string;
}

export async function insertEntry(sql: Sql, wallet: WalletRow, entry: EntryRow): Promise<string> {
  const id = newId();
  await sql(
    `insert into wallet_ledger_entries (
       id, wallet_id, wallet_version, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      id,
      entry.walletId ?? wallet.id,
      entry.version,
      entry.transactionId,
      entry.direction,
      entry.amount,
      entry.currency ?? wallet.currency,
      entry.before,
      entry.after,
    ],
  );
  return id;
}

/** Wallet + OPENING transaction + first ledger entry, the way the application will write them. */
export async function openWallet(orm: MikroORM, initialBalance = '100.00', currency = 'BRL'): Promise<WalletRow> {
  const wallet = { id: newId(), playerId: newId(), currency };

  await inTransaction(orm, async (sql) => {
    await sql(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, 1, now(), now())`,
      [wallet.id, wallet.playerId, currency, initialBalance],
    );
    if (Money.from({ amount: initialBalance, currency }).isPositive()) {
      const transactionId = await insertTransaction(sql, wallet, {
        providerId: 'internal',
        kind: 'OPENING',
        amount: initialBalance,
        status: 'PROCESSED',
        resultingBalance: initialBalance,
      });
      await insertEntry(sql, wallet, {
        version: 1,
        transactionId,
        direction: 'CREDIT',
        amount: initialBalance,
        before: '0.00',
        after: initialBalance,
      });
    }
  });

  return wallet;
}

/** A complete, valid balance movement: transaction, ledger entry and wallet update in one transaction. */
export async function move(
  orm: MikroORM,
  wallet: WalletRow,
  direction: 'DEBIT' | 'CREDIT',
  amount: string,
): Promise<{ transactionId: string; version: number }> {
  return inTransaction(orm, async (sql) => {
    const [current] = await sql(`select balance, version from wallets where id = ? for update`, [wallet.id]);
    const before = Money.from({ amount: String(current!.balance), currency: wallet.currency });
    const money = Money.from({ amount, currency: wallet.currency });
    const after = direction === 'CREDIT' ? before.add(money) : before.subtract(money);
    const version = Number(current!.version) + 1;

    const transactionId = await insertTransaction(sql, wallet, {
      kind: direction === 'CREDIT' ? 'WIN' : 'BET',
      amount,
      status: 'PROCESSED',
      resultingBalance: after.toJSON().amount,
    });
    await insertEntry(sql, wallet, {
      version,
      transactionId,
      direction,
      amount,
      before: before.toJSON().amount,
      after: after.toJSON().amount,
    });
    await sql(`update wallets set balance = ?, version = ?, updated_at = now() where id = ?`, [
      after.toJSON().amount,
      version,
      wallet.id,
    ]);
    return { transactionId, version };
  });
}
