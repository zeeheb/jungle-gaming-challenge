import { parseArgs } from 'node:util';
import { newId } from '../src/domain/shared/id';

// HTTP load test against a running instance (bun run dev, or the compose
// `app` profile). Run with `bun run test:load`; see docs/load-test.md for the
// method and the last recorded results.
//
// Mix: most bets spread over many wallets, a share aimed at a few "hot"
// wallets (to provoke lock contention) and a share of exact replays.

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env['LOAD_TEST_URL'] ?? 'http://localhost:3000' },
    duration: { type: 'string', default: '30' },
    concurrency: { type: 'string', default: '32' },
    wallets: { type: 'string', default: '200' },
    hot: { type: 'string', default: '4' },
    'hot-share': { type: 'string', default: '0.2' },
    'replay-share': { type: 'string', default: '0.05' },
  },
});

const url = values.url;
const durationMs = Number(values.duration) * 1_000;
const concurrency = Number(values.concurrency);
const hotShare = Number(values['hot-share']);
const replayShare = Number(values['replay-share']);

interface Wallet {
  id: string;
  playerId: string;
}

async function ready(): Promise<void> {
  const response = await fetch(`${url}/health/ready`).catch(() => undefined);
  if (!response?.ok) {
    console.error(`${url} is not ready: start it with "bun run dev" or "docker compose --profile app up -d --wait"`);
    process.exit(1);
  }
}

async function openWallet(): Promise<Wallet> {
  const playerId = `load-${newId()}`;
  const response = await fetch(`${url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } }),
  });
  const { id } = (await response.json()) as { id: string };
  return { id, playerId };
}

async function scrape(): Promise<Map<string, number>> {
  const text = await (await fetch(`${url}/metrics`)).text();
  const samples = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(\S+?)(\{.*\})?\s+(\S+)$/.exec(line);
    if (match && !line.startsWith('#')) {
      samples.set(`${match[1]}${match[2] ?? ''}`, Number(match[3]));
    }
  }
  return samples;
}

const sum = (samples: Map<string, number>, prefix: string) =>
  [...samples].filter(([key]) => key.startsWith(prefix)).reduce((total, [, value]) => total + value, 0);

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
}

await ready();
console.error(`preparing ${values.wallets} wallets + ${values.hot} hot wallets on ${url}...`);
const wallets = await Promise.all(Array.from({ length: Number(values.wallets) }, openWallet));
const hotWallets = await Promise.all(Array.from({ length: Number(values.hot) }, openWallet));

const before = await scrape();
const latencies: number[] = [];
const statuses = new Map<string, number>();
const sent: { body: string; key: string }[] = [];
let outboxLagMax = 0;
let outboxPendingMax = 0;

const deadline = performance.now() + durationMs;
const sampler = setInterval(async () => {
  const samples = await scrape().catch(() => undefined);
  if (samples) {
    outboxLagMax = Math.max(outboxLagMax, samples.get('wagering_outbox_lag_seconds') ?? 0);
    outboxPendingMax = Math.max(outboxPendingMax, samples.get('wagering_outbox_pending_messages') ?? 0);
  }
}, 500);

async function worker(): Promise<void> {
  while (performance.now() < deadline) {
    let request: { body: string; key: string };
    if (sent.length > 0 && Math.random() < replayShare) {
      request = sent[Math.floor(Math.random() * sent.length)]!; // an exact replay
    } else {
      const pool = Math.random() < hotShare ? hotWallets : wallets;
      const wallet = pool[Math.floor(Math.random() * pool.length)]!;
      const externalTransactionId = `load-${newId()}`;
      request = {
        key: `load:${externalTransactionId}`,
        body: JSON.stringify({
          providerId: 'load',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'load-round',
          gameId: 'load-game',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        }),
      };
      sent.push(request);
    }

    const startedAt = performance.now();
    const status = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': request.key },
      body: request.body,
    }).then(
      async (response) => {
        await response.arrayBuffer();
        return String(response.status);
      },
      () => 'network-error',
    );
    latencies.push(performance.now() - startedAt);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
}

const startedAt = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsedSeconds = (performance.now() - startedAt) / 1_000;
clearInterval(sampler);

// how long the relay needs to catch up once the load stops
const drainStartedAt = performance.now();
while ((await scrape()).get('wagering_outbox_pending_messages') !== 0 && performance.now() - drainStartedAt < 60_000) {
  await Bun.sleep(200);
}
const drainSeconds = (performance.now() - drainStartedAt) / 1_000;
const after = await scrape();

const sorted = [...latencies].sort((a, b) => a - b);
const total = latencies.length;
const errors = [...statuses].filter(([status]) => status === 'network-error' || Number(status) >= 500).reduce((n, [, c]) => n + c, 0);
const delta = (prefix: string) => sum(after, prefix) - sum(before, prefix);
const ms = (value: number) => `${value.toFixed(1)} ms`;

console.log(`| Metric | Value |
|---|---|
| Duration / concurrency | ${elapsedSeconds.toFixed(1)} s / ${concurrency} clients |
| Wallets | ${wallets.length} (+ ${hotWallets.length} hot, ${(hotShare * 100).toFixed(0)}% of bets) |
| Requests | ${total} (${(replayShare * 100).toFixed(0)}% replays) |
| Throughput | ${(total / elapsedSeconds).toFixed(0)} req/s |
| Latency p50 / p95 / p99 / max | ${ms(percentile(sorted, 50))} / ${ms(percentile(sorted, 95))} / ${ms(percentile(sorted, 99))} / ${ms(sorted.at(-1) ?? 0)} |
| HTTP statuses | ${[...statuses].sort().map(([status, count]) => `${status}: ${count}`).join(', ')} |
| Error rate (5xx + network) | ${((errors / total) * 100).toFixed(2)}% |
| Lock conflicts (lock_timeout, deadlock) | ${delta('wagering_lock_conflicts_total')} |
| Duplicates answered from storage | ${delta('wagering_duplicates_total')} |
| Outbox: max pending / max lag during the run | ${outboxPendingMax} events / ${outboxLagMax.toFixed(2)} s |
| Outbox: time to drain after the run | ${drainSeconds.toFixed(1)} s |`);
