import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config/app-config.ts';
import { createOrmConfig } from '../../src/database/mikro-orm.config.ts';

// loadConfig requires queue URLs even for DB-only tests; provide harmless
// defaults (these tests never touch SQS — they drive the use cases directly).
process.env.WAGER_QUEUE_URL ??= 'http://localhost:4566/000000000000/test.fifo';
process.env.WAGER_DLQ_URL ??= 'http://localhost:4566/000000000000/test-dlq.fifo';
process.env.EVENTS_QUEUE_URL ??= 'http://localhost:4566/000000000000/test-events.fifo';

const SUPERUSER = process.env.POSTGRES_SUPERUSER ?? 'postgres';
const SUPERPASS = process.env.POSTGRES_SUPERPASSWORD ?? 'postgres';

export interface TestDatabase {
  orm: MikroORM;
  dbName: string;
  teardown(): Promise<void>;
}

function adminConfig(dbName: string) {
  const base = loadConfig();
  // Reuse host/port but connect as the cluster superuser to the given database.
  return createOrmConfig(
    {
      ...base,
      postgres: { ...base.postgres, ownerUser: SUPERUSER, ownerPassword: SUPERPASS, dbName },
    },
    { asOwner: true },
  );
}

/**
 * Create a throwaway database, apply the migration into it, and return a MikroORM
 * bound to it as the restricted app role. Each test file gets full isolation; the
 * migration (constraints/triggers) is exercised for real.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const base = loadConfig();
  const dbName = `wagering_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // 1. Create the database owned by the owner role, via a superuser connection.
  const admin = await MikroORM.init(adminConfig('postgres'));
  try {
    await admin.em.getConnection().execute(`CREATE DATABASE "${dbName}" OWNER wagering_owner`);
  } finally {
    await admin.close(true);
  }

  // 2. Hand public schema to the owner and let the app role use it.
  const setup = await MikroORM.init(adminConfig(dbName));
  try {
    await setup.em.getConnection().execute('ALTER SCHEMA public OWNER TO wagering_owner');
    await setup.em.getConnection().execute('GRANT USAGE ON SCHEMA public TO wagering_app');
  } finally {
    await setup.close(true);
  }

  // 3. Run migrations as the owner role.
  const ownerOrm = await MikroORM.init(
    createOrmConfig({ ...base, postgres: { ...base.postgres, dbName } }, { asOwner: true }),
  );
  try {
    await ownerOrm.getMigrator().up();
  } finally {
    await ownerOrm.close(true);
  }

  // 4. Application ORM (restricted role) used by the tests.
  const orm = await MikroORM.init(
    createOrmConfig({ ...base, postgres: { ...base.postgres, dbName } }),
  );

  return {
    orm,
    dbName,
    async teardown() {
      await orm.close(true);
      const dropper = await MikroORM.init(adminConfig('postgres'));
      try {
        await dropper.em
          .getConnection()
          .execute(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await dropper.close(true);
      }
    },
  };
}
