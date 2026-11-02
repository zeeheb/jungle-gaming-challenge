import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/database/mikro-orm.config';

export type Row = Record<string, unknown>;
export type Sql = (query: string, params?: unknown[]) => Promise<Row[]>;

/**
 * DATABASE_URL already points at the test database (test/support/test-env.ts).
 * Tests drop the whole schema, so anything else is refused outright.
 */
export async function connectTestDatabase(): Promise<MikroORM> {
  const databaseName = new URL(config.clientUrl ?? '').pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing to run tests against database "${databaseName}"`);
  }
  return MikroORM.init({
    ...config,
    ensureDatabase: true,
    migrations: { ...config.migrations, silent: true },
  });
}

/**
 * Fresh schema for a test file: drops everything and migrates from scratch.
 * There is no truncate between tests (the schema forbids it), so tests rely on
 * fresh ids instead of empty tables.
 */
export async function setupTestDatabase(): Promise<MikroORM> {
  const orm = await connectTestDatabase();
  await resetSchema(orm);
  await orm.migrator.up();
  return orm;
}

export async function resetSchema(orm: MikroORM): Promise<void> {
  await orm.em.getConnection().executeDump('drop schema public cascade; create schema public;');
}

// Goes through the EntityManager rather than the raw connection: only the
// former converts driver errors into UniqueConstraintViolationException & co.
export function sqlFor(orm: MikroORM): Sql {
  return (query, params = []) => orm.em.fork().execute(query, params);
}

/** Polls until `condition` holds; for waiting on another connection's state. */
export async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
}

/** Number of sessions of this database currently blocked on a lock (row, tuple or unique index entry). */
export async function lockWaiters(sql: Sql): Promise<number> {
  const [row] = await sql(
    `select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return row!['waiting'] as number;
}

/** Makes an interleaving deterministic: returns once some other session is blocked on a lock. */
export function waitForLockWaiter(sql: Sql): Promise<void> {
  return waitUntil(async () => (await lockWaiters(sql)) > 0);
}

/** Runs `work` in one database transaction; deferred constraints are checked when it commits. */
export async function inTransaction<T>(orm: MikroORM, work: (sql: Sql) => Promise<T>): Promise<T> {
  return orm.em.fork().transactional((em) => work((query, params = []) => em.execute(query, params)));
}

/**
 * Plays "another instance" holding a wallet: takes the same row lock the use
 * case takes and keeps it until `release` is called.
 */
export async function holdWalletLock(orm: MikroORM, walletId: string): Promise<{ release(): Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));

  const holder = inTransaction(orm, async (sql) => {
    await sql('select id from wallets where id = ? for update', [walletId]);
    locked();
    await released;
  });
  await Promise.race([isLocked, holder]);
  return {
    release: async () => {
      release();
      await holder;
    },
  };
}
