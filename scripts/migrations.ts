import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';

const [command, name] = process.argv.slice(2);

const orm = await MikroORM.init(config);

try {
  switch (command) {
    case 'create': {
      const result = await orm.migrator.create(undefined, true, false, name);
      console.log(`created ${result.fileName}`);
      break;
    }
    case 'up': {
      const applied = await orm.migrator.up();
      console.log(applied.length ? applied.map((m) => `up: ${m.name}`).join('\n') : 'nothing to apply');
      break;
    }
    case 'down': {
      // reverts only the last migration, on purpose
      const reverted = await orm.migrator.down();
      console.log(reverted.length ? reverted.map((m) => `down: ${m.name}`).join('\n') : 'nothing to revert');
      break;
    }
    default:
      console.error('usage: bun scripts/migrations.ts <create [name] | up | down>');
      process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
