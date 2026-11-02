import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/database/mikro-orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering_test';

export type Row = Record<string, unknown>;
export type Sql = (query: string, params?: unknown[]) => Promise<Row[]>;

export async function connectTestDatabase(): Promise<MikroORM> {
  return MikroORM.init({
    ...config,
    clientUrl: TEST_DATABASE_URL,
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

/** Runs `work` in one database transaction; deferred constraints are checked when it commits. */
export async function inTransaction<T>(orm: MikroORM, work: (sql: Sql) => Promise<T>): Promise<T> {
  return orm.em.fork().transactional((em) => work((query, params = []) => em.execute(query, params)));
}
