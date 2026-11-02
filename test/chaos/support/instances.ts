import type { Subprocess } from 'bun';
import { join } from 'node:path';
import type { TestQueues } from '../../support/sqs';

const ROOT = join(import.meta.dir, '..', '..', '..');
const READY_TIMEOUT_MS = 30_000;

/** One real copy of the service: its own process, HTTP port, connection pool and background loops. */
export interface Instance {
  name: string;
  url: string;
  /** Every JSON log line it has written so far. */
  logs: Record<string, unknown>[];
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number>;
  /** Hard kill: no shutdown hooks, open transactions roll back, in-flight messages are not acked. */
  kill(): Promise<number>;
  metrics(): Promise<string>;
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/**
 * Starts `bun src/main.ts` exactly as in production, pointed at the test
 * database and at this test's queues, with short polling intervals.
 */
export async function startInstance(
  name: string,
  queues: TestQueues,
  overrides: Record<string, string> = {},
): Promise<Instance> {
  const port = freePort();
  const process_: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env, // DATABASE_URL already points at the test database
      PORT: String(port),
      LOG_LEVEL: 'info',
      SQS_TRANSACTIONS_QUEUE: queues.names.transactions,
      SQS_TRANSACTIONS_DLQ: queues.names.deadLetter,
      SQS_EVENTS_QUEUE: queues.names.events,
      CONSUMER_ENABLED: 'true',
      CONSUMER_WAIT_TIME_SECONDS: '1',
      CONSUMER_RETRY_BASE_MS: '200',
      OUTBOX_RELAY_ENABLED: 'true',
      OUTBOX_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
      ...overrides,
    },
  });

  const logs: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  void collectLines(process_.stdout, (line) => {
    try {
      logs.push(JSON.parse(line));
    } catch {
      stderr.push(line);
    }
  });
  void collectLines(process_.stderr, (line) => stderr.push(line));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (process_.exitCode !== null) {
      throw new Error(`${name} exited during startup:\n${stderr.join('\n')}`);
    }
    const ready = await fetch(`${url}/health/ready`).then((response) => response.ok, () => false);
    if (ready) {
      break;
    }
    if (Date.now() > deadline) {
      process_.kill();
      throw new Error(`${name} not ready after ${READY_TIMEOUT_MS}ms:\n${stderr.join('\n')}`);
    }
    await Bun.sleep(100);
  }

  return {
    name,
    url,
    logs,
    exited: process_.exited,
    kill: async () => {
      process_.kill('SIGKILL');
      return process_.exited;
    },
    metrics: async () => (await fetch(`${url}/metrics`)).text(),
  };
}

async function collectLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      if (line) {
        onLine(line);
      }
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
}
