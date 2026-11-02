import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { env } from '../../config/env';
import { entities } from './entities';

export default defineConfig({
  clientUrl: env.databaseUrl,
  entities,
  extensions: [Migrator],
  preferTs: true,
  forceUtcTimezone: true,
  migrations: {
    path: 'migrations',
    pathTs: 'migrations',
    glob: '!(*.d).{js,ts}',
    // Migrations are written by hand: the schema relies on CHECK constraints,
    // partial indexes and triggers that we want to review as plain SQL.
    snapshot: false,
    transactional: true,
    allOrNothing: true,
  },
});
