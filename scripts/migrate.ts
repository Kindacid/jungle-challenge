/**
 * Versioned, reversible migrations runner. Runs as the database OWNER role.
 *
 *   bun scripts/migrate.ts up      # apply all pending migrations
 *   bun scripts/migrate.ts down    # revert the last migration
 *   bun scripts/migrate.ts fresh   # drop everything and re-apply (dev/test only)
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/config/app-config.ts';
import { createOrmConfig } from '../src/database/mikro-orm.config.ts';

type Command = 'up' | 'down' | 'fresh';

async function main(): Promise<void> {
  const command = (process.argv[2] ?? 'up') as Command;
  const config = loadConfig();
  const orm = await MikroORM.init(createOrmConfig(config, { asOwner: true }));
  const migrator = orm.getMigrator();

  try {
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(`applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ') || '(none)'}`);
        break;
      }
      case 'down': {
        const reverted = await migrator.down();
        console.log(`reverted ${reverted.length} migration(s): ${reverted.map((m) => m.name).join(', ') || '(none)'}`);
        break;
      }
      case 'fresh': {
        await migrator.down({ to: 0 });
        const applied = await migrator.up();
        console.log(`fresh: re-applied ${applied.length} migration(s)`);
        break;
      }
      default:
        throw new Error(`unknown command: ${command} (use up|down|fresh)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
