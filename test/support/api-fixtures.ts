import { expect } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import type { MoneyProps } from '../../src/domain/shared/money';
import type { WalletView } from '../../src/http/views';
import type { Api, ApiResponse } from './app';
import type { Row, Sql } from './database';

// Fixtures that go through the public API, the way a provider would.

export const money = (amount: string, currency = 'BRL'): MoneyProps => ({ amount, currency });

export async function openWallet(api: Api, amount = '100.00', currency = 'BRL'): Promise<WalletView> {
  const response = await api.post('/wallets', { playerId: `player-${newId()}`, initialBalance: money(amount, currency) });
  expect(response.status).toBe(201);
  return response.body;
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** A 10.00 BET on `wallet` with a fresh externalTransactionId, unless told otherwise. */
export function wagerBody(wallet: WalletView, overrides: Partial<WagerBody> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: money('10.00', wallet.balance.currency),
    ...overrides,
  };
}

/** The recommended default: "{providerId}:{externalTransactionId}". */
export const keyOf = (body: Pick<WagerBody, 'providerId' | 'externalTransactionId'>): string =>
  `${body.providerId}:${body.externalTransactionId}`;

export function submit(api: Api, body: unknown, idempotencyKey = keyOf(body as WagerBody)): Promise<ApiResponse> {
  return api.post('/wagering/transactions', body, { 'Idempotency-Key': idempotencyKey });
}

export async function balanceOf(api: Api, walletId: string): Promise<string> {
  const response = await api.get(`/wallets/${walletId}`);
  return response.body.balance.amount;
}

/** A wallet's ledger, oldest entry first. */
export function ledgerOf(sql: Sql, walletId: string): Promise<Row[]> {
  return sql(
    `select wallet_version as version, direction, amount, balance_after as "balanceAfter"
       from wallet_ledger_entries where wallet_id = ? order by wallet_version`,
    [walletId],
  );
}

/** Types of the events waiting in the outbox for one transaction, sorted. */
export async function eventsOf(sql: Sql, transactionId: string): Promise<string[]> {
  const rows = await sql(
    `select event_type from outbox_messages where payload -> 'data' ->> 'transactionId' = ? order by event_type`,
    [transactionId],
  );
  return rows.map((row) => row['event_type'] as string);
}

export async function countTransactions(sql: Sql, walletId: string): Promise<number> {
  const [row] = await sql(`select count(*)::int as count from wager_transactions where wallet_id = ?`, [walletId]);
  return row!['count'] as number;
}

/**
 * The invariant every test must leave behind, for every wallet in the
 * database: balance == sum of its ledger, and version == its last entry's
 * version (1 for a wallet opened empty, which has no entries).
 */
export function inconsistentWallets(sql: Sql): Promise<Row[]> {
  return sql(`
    select w.id, w.balance, w.version, ledger.balance as ledger_balance, ledger.last_version
      from wallets w
      cross join lateral (
        select coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(20, 2) as balance,
               coalesce(max(e.wallet_version), 1) as last_version
          from wallet_ledger_entries e
         where e.wallet_id = w.id
      ) ledger
     where w.balance <> ledger.balance or w.version <> ledger.last_version`);
}
