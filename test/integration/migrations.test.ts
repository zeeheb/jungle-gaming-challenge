import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { connectTestDatabase, resetSchema, sqlFor } from '../support/database';

let orm: MikroORM;

beforeAll(async () => {
  orm = await connectTestDatabase();
  await resetSchema(orm);
});

afterAll(async () => {
  await orm.close(true);
});

async function schemaObjects() {
  const sql = sqlFor(orm);
  const tables = await sql(
    `select table_name as name from information_schema.tables
      where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
      order by 1`,
  );
  const functions = await sql(
    `select routine_name as name from information_schema.routines where routine_schema = 'public' order by 1`,
  );
  return { tables: tables.map((t) => t.name), functions: functions.map((f) => f.name) };
}

describe('migrations', () => {
  it('build the schema from scratch', async () => {
    await orm.migrator.up();

    const { tables, functions } = await schemaObjects();
    expect(tables).toEqual(['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);
    expect(functions).toContain('reject_mutation');
  });

  it('are reversible all the way down and back up', async () => {
    const migrations = (await orm.migrator.getExecuted()).length;

    await orm.migrator.down({ to: 0 });
    expect(await schemaObjects()).toEqual({ tables: [], functions: [] });
    expect(await orm.migrator.getPending()).toHaveLength(migrations);

    await orm.migrator.up();
    expect((await schemaObjects()).tables).toHaveLength(5);
    expect(await orm.migrator.getPending()).toHaveLength(0);
  });
});
