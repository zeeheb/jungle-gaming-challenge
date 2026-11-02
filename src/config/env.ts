function read(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function readInt(name: string, fallback: number): number {
  const raw = read(name, String(fallback));
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = read(name, String(fallback)).toLowerCase();
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`Environment variable ${name} must be true or false, got "${raw}"`);
  }
  return raw === 'true';
}

// Defaults match docker-compose.yml so `bun run dev` works without a .env file.
export const env = {
  port: readInt('PORT', 3000),
  logLevel: read('LOG_LEVEL', 'info'),
  databaseUrl: read('DATABASE_URL', 'postgres://wagering:wagering@localhost:5432/wagering'),
  // How long a request waits for a busy wallet before giving up with a retryable error.
  lockTimeoutMs: readInt('DB_LOCK_TIMEOUT_MS', 5_000),
  sqs: {
    endpoint: read('SQS_ENDPOINT', 'http://localhost:4566'),
    region: read('AWS_REGION', 'us-east-1'),
    // MiniStack accepts any credentials; on real AWS these would come from the
    // default provider chain (task role) instead of env vars.
    accessKeyId: read('AWS_ACCESS_KEY_ID', 'test'),
    secretAccessKey: read('AWS_SECRET_ACCESS_KEY', 'test'),
    transactionsQueue: read('SQS_TRANSACTIONS_QUEUE', 'wager-transactions.fifo'),
    transactionsDlq: read('SQS_TRANSACTIONS_DLQ', 'wager-transactions-dlq.fifo'),
    eventsQueue: read('SQS_EVENTS_QUEUE', 'wager-events.fifo'),
  },
  consumer: {
    enabled: readBool('CONSUMER_ENABLED', true),
    waitTimeSeconds: readInt('CONSUMER_WAIT_TIME_SECONDS', 10),
    maxMessages: readInt('CONSUMER_MAX_MESSAGES', 10),
    // same as the queue's maxReceiveCount (docker/ministack/ready.d)
    maxAttempts: readInt('CONSUMER_MAX_ATTEMPTS', 5),
    // retries after 2s, 4s, 8s, 16s: about half a minute before the DLQ
    retryBaseDelayMs: readInt('CONSUMER_RETRY_BASE_MS', 2_000),
    retryMaxDelayMs: readInt('CONSUMER_RETRY_MAX_MS', 60_000),
  },
  outbox: {
    enabled: readBool('OUTBOX_RELAY_ENABLED', true),
    batchSize: readInt('OUTBOX_BATCH_SIZE', 10),
    pollIntervalMs: readInt('OUTBOX_POLL_INTERVAL_MS', 500),
  },
  // Chaos testing only: never set in a real deployment.
  faults: {
    // the process exits right after committing a new transaction, before acking its message
    crashAfterCommit: readBool('FAULT_CRASH_AFTER_COMMIT', false),
  },
  pendingReferences: {
    enabled: readBool('PENDING_REFERENCE_WORKER_ENABLED', true),
    batchSize: readInt('PENDING_REFERENCE_BATCH_SIZE', 20),
    // the shortest backoff is 1s, so checking every 500ms keeps the delay close to it
    pollIntervalMs: readInt('PENDING_REFERENCE_POLL_INTERVAL_MS', 500),
  },
} as const;

export type Env = typeof env;
