import {
  ConnectionException,
  DeadlockException,
  UniqueConstraintViolationException,
  type MikroORM,
} from '@mikro-orm/postgresql';
import {
  DuplicateTransactionError,
  TransientFailureError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import type { Repositories, UnitOfWork } from '../../application/unit-of-work';
import { createRepositories } from './repositories';

export interface UnitOfWorkOptions {
  /** Longest wait for a row lock before the unit of work fails with TransientFailureError. */
  lockTimeoutMs: number;
}

const DUPLICATE_TRANSACTION_CONSTRAINTS = new Set([
  'wager_transactions_provider_idempotency_key',
  'wager_transactions_provider_external_key',
]);

// Nothing is wrong with the request itself: the database was busy or briefly
// unreachable, and the same request may succeed a moment later.
const TRANSIENT_ERROR_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available: lock_timeout expired (MikroORM has no class for it)
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now: server still starting
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
  ) {
    if (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0) {
      throw new Error(`lockTimeoutMs must be a positive integer, got ${options.lockTimeoutMs}`);
    }
  }

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      // A fresh EntityManager per unit of work: its own identity map, nothing
      // shared between concurrent requests. `transactional` flushes the Unit of
      // Work and commits when `work` resolves, and rolls back if anything throws.
      return await this.orm.em.fork().transactional(async (em) => {
        // Bounded wait for row locks: a hot wallet answers "retry later" instead
        // of piling up requests that each hold a pooled connection.
        await em.execute(`set local lock_timeout = ${this.options.lockTimeoutMs}`);
        return work(createRepositories(em));
      });
    } catch (error) {
      throw translate(error);
    }
  }
}

// Constraint names are a database detail; the application only sees what they mean.
function translate(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    const constraint = (error as { constraint?: string }).constraint;
    if (constraint === 'wallets_player_currency_key') {
      return new WalletAlreadyExistsError('This player already has a wallet in this currency', { cause: error });
    }
    if (constraint !== undefined && DUPLICATE_TRANSACTION_CONSTRAINTS.has(constraint)) {
      return new DuplicateTransactionError(`Transaction already exists (${constraint})`, { cause: error });
    }
    return error;
  }
  if (isTransient(error)) {
    return new TransientFailureError('The database is temporarily unavailable or busy; retry the request', {
      cause: error,
    });
  }
  return error;
}

function isTransient(error: unknown): boolean {
  if (error instanceof ConnectionException || error instanceof DeadlockException) {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code);
}
