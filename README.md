# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas de múltiplos
provedores, mantendo **correção financeira, idempotência e consistência** mesmo
com mensagens **duplicadas, fora de ordem ou concorrentes**, e com **múltiplas
instâncias** rodando ao mesmo tempo.

> Desafio técnico da Jungle Gaming. O enunciado original está em
> [`docs/CHALLENGE.md`](docs/CHALLENGE.md). As decisões de arquitetura e os
> trade-offs estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Licença / uso

Código sob **licença proprietária de avaliação** — ver [`LICENSE`](LICENSE).
Entregue exclusivamente para avaliação do processo seletivo; uso fora desse
contexto não é autorizado sem permissão por escrito. Recomendação: manter o
repositório **privado** no GitHub, conceder acesso por pessoa e acompanhar
clones/visitas em *Insights → Traffic*.

---

## Stack

- **Bun 1.x** (runtime, gerenciador de pacotes e test runner)
- **TypeScript** estrito · **NestJS 11**
- **PostgreSQL 17** · **MikroORM 6** (migrations versionadas e reversíveis)
- **AWS SQS** via **MiniStack** (emulador local, sem token)
- **Docker Compose** para orquestração local
- `prom-client` (métricas) · `nestjs-pino` (logs JSON) · `decimal.js` (dinheiro)

---

## Pré-requisitos

- **Docker Desktop** (com backend WSL2 no Windows) — para Postgres + MiniStack.
- **Bun 1.x** — apenas se for rodar fora do Docker (`powershell -c "irm bun.sh/install.ps1 | iex"` no Windows; `curl -fsSL https://bun.sh/install | bash` no Linux/macOS).

Tudo roda em containers; não é preciso instalar Postgres nem Bun localmente para
subir o sistema via Compose.

---

## Subindo com Docker Compose

```bash
cp .env.example .env            # ajuste se quiser
docker compose up --build       # postgres + ministack + migrate + queues + app
```

A ordem é garantida pelo Compose:

1. `postgres` sobe e cria os papéis (`wagering_owner`, `wagering_app`);
2. `migrate` aplica a migration como **owner** (o app conecta como papel restrito);
3. `queue-init` cria as filas FIFO (`wager-transactions.fifo`, DLQ e `wagering-events.fifo`);
4. `app` sobe com `APP_ROLE=all` (API + workers) em `http://localhost:3000`.

Verifique: `curl http://localhost:3000/health/ready`.

### Múltiplas instâncias (requisito do desafio)

```bash
docker compose up --build --scale app=3
```

Cada réplica recebe uma porta do range `3000-3010`. As três disputam as mesmas
wallets e a mesma outbox — a correção é mantida pelos locks e constraints no banco
(ver `ARCHITECTURE.md`). O papel é escolhido por `APP_ROLE` (`api` | `worker` | `all`).

---

## Comandos

| Comando | O que faz |
|---|---|
| `bun install` | instala dependências |
| `bun run migrate:up` / `migrate:down` | aplica / reverte migrations (como owner) |
| `bun run queues:create` | cria as filas (idempotente) |
| `bun run start` | sobe o serviço (usa as variáveis de ambiente) |
| `bun run dev` | sobe em watch mode |
| `bun run typecheck` | checagem estrita de tipos |
| `bun run lint` / `lint:fix` | Biome |
| `bun run di-check` | **boota o grafo de DI sem banco** (valida wiring) |
| `bun run test:unit` | testes de unidade (puro domínio, sem containers) |
| `bun run test:integration` | integração (Postgres + MiniStack reais) |
| `bun run test:concurrency` | corridas reais / múltiplos processos |
| `bun run test` | unit + integration + concurrency |
| `bun run test:load` | teste de carga (gera `docs/LOAD_TEST.md`) |

> Integração e concorrência exigem Postgres e MiniStack de pé. Suba-os com
> `docker compose up -d postgres ministack` antes (as suítes criam bancos/filas
> isolados por arquivo de teste).

---

## Endpoints

```
POST /wallets                                             cria wallet (+ OPENING)
GET  /wallets/:walletId                                   saldo e versão
GET  /wallets/:walletId/ledger?cursor=&limit=             ledger paginado (cursor opaco)
POST /wallets/:walletId/reconciliation                    reconciliação (nunca corrige em silêncio)
POST /wagering/transactions   (header Idempotency-Key)    submete BET/WIN/LOSS/REFUND/ROLLBACK
GET  /wagering/transactions/:transactionId                consulta por id interno
GET  /providers/:providerId/wagering/transactions/:extId  consulta por id do provedor
GET  /health/live  ·  GET /health/ready  ·  GET /metrics  liveness / readiness / Prometheus
```

Mapeamento de status HTTP (consistente em todos os endpoints): **200** processado
(novo ou replay), **202** pendente de referência, **422** rejeição de regra de
negócio, **400** payload inválido / falta `Idempotency-Key`, **409** conflito de
idempotência / wallet duplicada, **404** não encontrado, **503** falha transitória
(com `Retry-After`). Erros usam `application/problem+json` com `code` + `retryable`.

### Smoke test (cenário obrigatório da seção 8)

```bash
# cria wallet com 100.00
curl -sX POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# => { "id": "<WALLET>", "balance": {"amount":"100.00",...}, "version": 1 }

# duas apostas de 80.00 em paralelo -> uma PROCESSED (200), outra REJECTED (422)
WALLET=<WALLET>
curl -sX POST localhost:3000/wagering/transactions -H 'Idempotency-Key: p:t1' -H 'content-type: application/json' \
  -d "{\"providerId\":\"p\",\"externalTransactionId\":\"t1\",\"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}" &
curl -sX POST localhost:3000/wagering/transactions -H 'Idempotency-Key: p:t2' -H 'content-type: application/json' \
  -d "{\"providerId\":\"p\",\"externalTransactionId\":\"t2\",\"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}" &
wait
# saldo final 20.00, exatamente um débito no ledger

# replay: mesma key e mesmo payload -> idempotentReplay: true (200)
curl -sX POST localhost:3000/wagering/transactions -H 'Idempotency-Key: p:t1' -H 'content-type: application/json' \
  -d "{\"providerId\":\"p\",\"externalTransactionId\":\"t1\",\"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"

# mesma key, payload diferente -> 409 (conflito, não replay)
curl -isX POST localhost:3000/wagering/transactions -H 'Idempotency-Key: p:t1' -H 'content-type: application/json' \
  -d "{\"providerId\":\"p\",\"externalTransactionId\":\"t1\",\"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"walletId\":\"$WALLET\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"81.00\",\"currency\":\"BRL\"}}" | head -1

curl -sX POST localhost:3000/wallets/$WALLET/reconciliation   # consistent: true
```

### Enviar pela fila (SQS)

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id msg-1 \
  --message-body '{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"p","externalTransactionId":"q1","idempotencyKey":"p:q1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"'$WALLET'","roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

---

## Observabilidade

- **Logs JSON** (pino) com `correlationId` por requisição; headers sensíveis e
  bodies financeiros são redigidos.
- **Métricas** em `/metrics` (Prometheus): transações por status, duplicatas,
  retries, DLQ, conflitos de lock, `outbox_lag_seconds`, latência de processamento
  e divergências de reconciliação.
- **Health**: `/health/live` (processo) e `/health/ready` (Postgres + SQS).

---

## Estrutura

```
src/
  shared/domain/        Money, Clock, IdGenerator, canonical hash, erros de domínio
  wallet/               Wallet + LedgerEntry (domínio), use cases, repo, HTTP
  wagering/             WagerTransaction + WagerProcessor, use cases, repo, HTTP, resolver
  messaging/            IntegrationEvents, Inbox/Outbox, consumer SQS, publisher, gateway
  database/             migration (schema + constraints + triggers), MikroORM, TransactionRunner
  observability/        métricas, logger, health
  auth/                 ProviderAuthGuard (no-op) + ProviderIdentityPort (extensão)
  worker/               módulo dos workers (consumer, publisher, resolver)
scripts/                migrate, create-queues, di-check, load-test
test/                   unit, integration, concurrency, support
```

Mais detalhes, invariantes e decisões: [`ARCHITECTURE.md`](ARCHITECTURE.md).
