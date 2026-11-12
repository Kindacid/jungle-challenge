# Load test

**Ambiente:** http://localhost:3001 · 2026-11-12T17:26:28.436Z
**Metodologia:** 1500 requisições `POST /wagering/transactions` (BET 1.00),
concorrência 40, misturando 5 wallets "quentes" (contenção) e
50 wallets "frias". Cada requisição usa uma `Idempotency-Key` única.

## Resultados

| Métrica | Valor |
|---|---|
| Throughput | 228.1 req/s |
| Duração | 6.57 s |
| p50 | 160.8 ms |
| p95 | 275.6 ms |
| p99 | 318.8 ms |
| máx | 686.5 ms |
| OK (200/202) | 1500 |
| Rejeições (422) | 0 |
| Erros | 0 |
| Taxa de erro | 0.00 % |
| Conflitos de lock (delta) | 0 |
| Outbox pendente logo após a carga | 546 |
| Outbox lag no pico (s) | 1.322 |
| Tempo para drenar a outbox | 7.48 s |
| Outbox pendente final | 0 |

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
