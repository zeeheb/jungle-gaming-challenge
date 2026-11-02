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

// Defaults match docker-compose.yml so `bun run dev` works without a .env file.
export const env = {
  port: readInt('PORT', 3000),
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
} as const;

export type Env = typeof env;
