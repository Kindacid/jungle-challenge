/**
 * Typed application configuration parsed from the environment. Kept free of any
 * Nest dependency so standalone scripts (migrations, queue setup, load test) can
 * import it without booting the framework.
 */

export type AppRole = 'api' | 'worker' | 'all';

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n)) throw new Error(`env var ${name} must be an integer, got ${v}`);
  return n;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export interface PostgresConfig {
  host: string;
  port: number;
  dbName: string;
  appUser: string;
  appPassword: string;
  ownerUser: string;
  ownerPassword: string;
  poolMin: number;
  poolMax: number;
}

export interface SqsConfig {
  region: string;
  endpointUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
}

export interface WorkerConfig {
  consumerMaxAttempts: number;
  outboxBatchSize: number;
  outboxLeaseSeconds: number;
  outboxPollMs: number;
  pendingReferencePollMs: number;
  pendingReferenceMaxAttempts: number;
  shutdownDrainMs: number;
}

export interface AppConfig {
  role: AppRole;
  httpPort: number;
  nodeEnv: string;
  logLevel: string;
  instanceId: string;
  walletLockTimeoutMs: number;
  txMaxRetries: number;
  chaosCrashAfterCommit: boolean;
  postgres: PostgresConfig;
  sqs: SqsConfig;
  worker: WorkerConfig;
}

export function loadConfig(): AppConfig {
  const role = str('APP_ROLE', 'all') as AppRole;
  if (!['api', 'worker', 'all'].includes(role)) {
    throw new Error(`invalid APP_ROLE: ${role}`);
  }

  return {
    role,
    httpPort: int('HTTP_PORT', 3000),
    nodeEnv: str('NODE_ENV', 'development'),
    logLevel: str('LOG_LEVEL', 'info'),
    // A unique id per process; used to tag outbox leases and logs.
    instanceId: str('INSTANCE_ID', `${process.pid}-${Bun.randomUUIDv7().slice(0, 8)}`),
    walletLockTimeoutMs: int('WALLET_LOCK_TIMEOUT_MS', 5000),
    txMaxRetries: int('TX_MAX_RETRIES', 5),
    chaosCrashAfterCommit: bool('CHAOS_CRASH_AFTER_COMMIT', false),
    postgres: {
      host: str('POSTGRES_HOST', 'localhost'),
      port: int('POSTGRES_PORT', 5432),
      dbName: str('POSTGRES_DB', 'wagering'),
      appUser: str('POSTGRES_APP_USER', 'wagering_app'),
      appPassword: str('POSTGRES_APP_PASSWORD', 'wagering_app_pwd'),
      ownerUser: str('POSTGRES_OWNER_USER', 'wagering_owner'),
      ownerPassword: str('POSTGRES_OWNER_PASSWORD', 'wagering_owner_pwd'),
      poolMin: int('POSTGRES_POOL_MIN', 2),
      poolMax: int('POSTGRES_POOL_MAX', 20),
    },
    sqs: {
      region: str('AWS_REGION', 'us-east-1'),
      endpointUrl: str('AWS_ENDPOINT_URL', 'http://localhost:4566'),
      accessKeyId: str('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: str('AWS_SECRET_ACCESS_KEY', 'test'),
      wagerQueueUrl: str('WAGER_QUEUE_URL'),
      wagerDlqUrl: str('WAGER_DLQ_URL'),
      eventsQueueUrl: str('EVENTS_QUEUE_URL'),
      maxMessages: int('SQS_MAX_MESSAGES', 10),
      waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 20),
      visibilityTimeoutSeconds: int('SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
    },
    worker: {
      consumerMaxAttempts: int('CONSUMER_MAX_ATTEMPTS', 5),
      outboxBatchSize: int('OUTBOX_BATCH_SIZE', 50),
      outboxLeaseSeconds: int('OUTBOX_LEASE_SECONDS', 30),
      outboxPollMs: int('OUTBOX_POLL_MS', 500),
      pendingReferencePollMs: int('PENDING_REFERENCE_POLL_MS', 1000),
      pendingReferenceMaxAttempts: int('PENDING_REFERENCE_MAX_ATTEMPTS', 10),
      shutdownDrainMs: int('SHUTDOWN_DRAIN_MS', 20000),
    },
  };
}
