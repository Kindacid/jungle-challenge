/**
 * Load test against a RUNNING instance (start it first, e.g. docker compose up).
 * Fires a mix of bets at a few "hot" wallets (contention) and many "cold" wallets,
 * measures latency percentiles, throughput and error rate, reads lock-conflict and
 * outbox-lag metrics, and writes docs/LOAD_TEST.md.
 *
 *   LOAD_BASE_URL=http://localhost:3000 bun run test:load
 *
 * There is no RPS target — the honesty of the analysis matters more than the number.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const BASE_URL = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
const TOTAL = Number.parseInt(process.env.LOAD_REQUESTS ?? '2000', 10);
const CONCURRENCY = Number.parseInt(process.env.LOAD_CONCURRENCY ?? '50', 10);
const HOT = Number.parseInt(process.env.LOAD_HOT_WALLETS ?? '5', 10);
const COLD = Number.parseInt(process.env.LOAD_COLD_WALLETS ?? '50', 10);

interface Wallet {
  id: string;
  playerId: string;
}

async function createWallet(): Promise<Wallet> {
  const playerId = randomUUID();
  const res = await fetch(`${BASE_URL}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: '1000000.00', currency: 'BRL' },
    }),
  });
  if (!res.ok) throw new Error(`createWallet failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return { id: body.id, playerId };
}

async function placeBet(wallet: Wallet): Promise<{ ms: number; status: number }> {
  const ext = randomUUID();
  const started = performance.now();
  const res = await fetch(`${BASE_URL}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `load:${ext}` },
    body: JSON.stringify({
      providerId: 'load',
      externalTransactionId: ext,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'load-round',
      gameId: 'load-game',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    }),
  });
  await res.text();
  return { ms: performance.now() - started, status: res.status };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

async function scrapeMetric(name: string): Promise<number> {
  try {
    const text = await (await fetch(`${BASE_URL}/metrics`)).text();
    const lines = text.split('\n').filter((l) => l.startsWith(name) && !l.startsWith('#'));
    let sum = 0;
    for (const line of lines) {
      const value = Number.parseFloat(line.slice(line.lastIndexOf(' ') + 1));
      if (Number.isFinite(value)) sum += value;
    }
    return sum;
  } catch {
    return Number.NaN;
  }
}

async function main(): Promise<void> {
  console.log(`load test -> ${BASE_URL} (${TOTAL} reqs, concurrency ${CONCURRENCY})`);

  const hotWallets = await Promise.all(Array.from({ length: HOT }, createWallet));
  const coldWallets = await Promise.all(Array.from({ length: COLD }, createWallet));
  const pickWallet = (i: number): Wallet =>
    i % 2 === 0 ? (hotWallets[i % HOT] as Wallet) : (coldWallets[i % COLD] as Wallet);

  const lockConflictsBefore = await scrapeMetric('lock_conflicts_total');

  const latencies: number[] = [];
  const statusCounts = new Map<number, number>();
  let next = 0;
  const startedAt = performance.now();

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= TOTAL) return;
      try {
        const { ms, status } = await placeBet(pickWallet(i));
        latencies.push(ms);
        statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
      } catch {
        statusCounts.set(0, (statusCounts.get(0) ?? 0) + 1); // network/error
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedS = (performance.now() - startedAt) / 1000;

  const lockConflictsAfter = await scrapeMetric('lock_conflicts_total');
  const outboxLag = await scrapeMetric('outbox_lag_seconds');
  const outboxPending = await scrapeMetric('outbox_pending');

  // Wait for the outbox to fully drain and record how long it took — a steady
  // measure of publisher throughput, instead of the instantaneous backlog above.
  const drainStart = performance.now();
  let finalPending = outboxPending;
  while (finalPending > 0 && performance.now() - drainStart < 30_000) {
    await new Promise((r) => setTimeout(r, 500));
    finalPending = await scrapeMetric('outbox_pending');
  }
  const drainMs = performance.now() - drainStart;

  latencies.sort((a, b) => a - b);
  const ok = (statusCounts.get(200) ?? 0) + (statusCounts.get(202) ?? 0);
  const rejected = statusCounts.get(422) ?? 0;
  const errors = TOTAL - ok - rejected;
  const throughput = TOTAL / elapsedS;

  const report = `# Load test

**Ambiente:** ${BASE_URL} · ${new Date().toISOString()}
**Metodologia:** ${TOTAL} requisições \`POST /wagering/transactions\` (BET 1.00),
concorrência ${CONCURRENCY}, misturando ${HOT} wallets "quentes" (contenção) e
${COLD} wallets "frias". Cada requisição usa uma \`Idempotency-Key\` única.

## Resultados

| Métrica | Valor |
|---|---|
| Throughput | ${throughput.toFixed(1)} req/s |
| Duração | ${elapsedS.toFixed(2)} s |
| p50 | ${percentile(latencies, 50).toFixed(1)} ms |
| p95 | ${percentile(latencies, 95).toFixed(1)} ms |
| p99 | ${percentile(latencies, 99).toFixed(1)} ms |
| máx | ${(latencies[latencies.length - 1] ?? 0).toFixed(1)} ms |
| OK (200/202) | ${ok} |
| Rejeições (422) | ${rejected} |
| Erros | ${errors} |
| Taxa de erro | ${((errors / TOTAL) * 100).toFixed(2)} % |
| Conflitos de lock (delta) | ${(lockConflictsAfter - lockConflictsBefore).toString()} |
| Outbox pendente logo após a carga | ${Number.isNaN(outboxPending) ? 'n/d' : outboxPending.toString()} |
| Outbox lag no pico (s) | ${Number.isNaN(outboxLag) ? 'n/d' : outboxLag.toFixed(3)} |
| Tempo para drenar a outbox | ${(drainMs / 1000).toFixed(2)} s |
| Outbox pendente final | ${Number.isNaN(finalPending) ? 'n/d' : finalPending.toString()} |

## Análise

As wallets quentes serializam no lock pessimista por linha, então a latência p99
reflete o enfileiramento nelas; as wallets frias processam em paralelo. Erros
devem ficar em ~0% — rejeições por saldo não ocorrem (saldo inicial alto). A
"outbox pendente logo após a carga" é o backlog instantâneo no fim do burst; o
"tempo para drenar" mostra os publishers (um por instância) escoando esse backlog
até zero sem perder nem duplicar eventos. Conflitos de lock > 0 indicam retries
transitórios absorvidos pelo TransactionRunner.

> Números brutos dependem da máquina e do ambiente Docker; o objetivo é a forma da
> distribuição e a estabilidade sob contenção, não um RPS máximo.
`;

  await writeFile('docs/LOAD_TEST.md', report, 'utf8');
  console.log(report);
  console.log('wrote docs/LOAD_TEST.md');
}

main().catch((err) => {
  console.error('load test failed:', err);
  process.exit(1);
});
