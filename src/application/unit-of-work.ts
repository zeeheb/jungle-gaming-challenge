import type { OutboxMessage } from '../domain/messaging/outbox-message';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';

// Ports: what the use cases need from storage, in domain terms. The MikroORM
// adapter lives in infrastructure/database; nothing here knows about SQL.

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * Same as findById, but the wallet stays locked until the unit of work ends:
   * any other writer of this wallet, in this process or another, waits for us.
   */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  /** Saves the balance and version of a wallet loaded by this same unit of work. */
  update(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Whether a processed REFUND or ROLLBACK already reverts this transaction. */
  isReversed(transactionId: string): Promise<boolean>;
  add(transaction: WagerTransaction): void;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): void;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

/**
 * One database transaction. `add`/`update` only register changes; they are
 * written together when `work` resolves, and if anything fails nothing is.
 *
 * Besides whatever `work` throws, `run` fails with:
 * - DuplicateTransactionError: an added transaction reuses an idempotency key or external id;
 * - WalletAlreadyExistsError: an added wallet reuses player + currency;
 * - TransientFailureError: lock timeout, deadlock or connection trouble (safe to retry).
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

/** Injection token for the port (interfaces do not exist at runtime). */
export const UNIT_OF_WORK = Symbol('UnitOfWork');
