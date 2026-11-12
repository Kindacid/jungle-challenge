import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import type { AppConfig } from '../config/app-config.ts';
import { Migration20261112_0001_init } from './migrations/Migration20261112_0001_init.ts';
import { ALL_SCHEMAS } from './records.ts';

/**
 * Build a MikroORM config. The application uses the restricted `wagering_app`
 * role; migrations use the owner role (`asOwner: true`). Migrations are
 * registered explicitly (migrationsList) rather than discovered by glob, which
 * is robust under Bun's ESM loader.
 */
export function createOrmConfig(config: AppConfig, opts: { asOwner?: boolean } = {}): Options {
  const pg = config.postgres;
  const user = opts.asOwner ? pg.ownerUser : pg.appUser;
  const password = opts.asOwner ? pg.ownerPassword : pg.appPassword;

  return defineConfig({
    host: pg.host,
    port: pg.port,
    dbName: pg.dbName,
    user,
    password,
    // Bound how long a statement waits for a row lock and how long any statement
    // or idle-in-transaction session may run. Applied per connection via libpq
    // `options`, so every session inherits them without a per-tx `SET LOCAL`.
    driverOptions: {
      connection: {
        options:
          `-c lock_timeout=${config.walletLockTimeoutMs} ` +
          '-c statement_timeout=30000 ' +
          '-c idle_in_transaction_session_timeout=15000',
      },
    },
    entities: ALL_SCHEMAS,
    // Schemas are already compiled classes; no TS discovery needed.
    discovery: { disableDynamicFileAccess: true },
    extensions: [Migrator],
    pool: { min: pg.poolMin, max: pg.poolMax },
    // We never auto-sync; the versioned migration is the single source of truth.
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      disableForeignKeys: false,
      allOrNothing: true,
      snapshot: false,
      migrationsList: [
        { name: 'Migration20261112_0001_init', class: Migration20261112_0001_init },
      ],
    },
    debug: config.nodeEnv === 'development' && process.env.MIKRO_ORM_DEBUG === 'true',
  });
}
