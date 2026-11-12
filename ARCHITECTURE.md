# Arquitetura e decisões

Documento das decisões técnicas, invariantes e trade-offs do serviço. O enunciado
está em [`docs/CHALLENGE.md`](docs/CHALLENGE.md).

## 1. Princípio central

> **As invariantes de negócio são garantidas no banco, não só no código.**

Unicidade, imutabilidade, não-negatividade do saldo e a relação 1:1 entre saldo e
ledger são impostas por *constraints* e *triggers* no PostgreSQL. O código da
aplicação é a primeira linha de defesa (ergonomia e mensagens claras); o schema é
a linha final, e é ele que mantém a correção sob concorrência e com múltiplas
instâncias. Ver a migration em
[`src/database/migrations`](src/database/migrations/Migration20261112_0001_init.ts).

## 2. Camadas (DDD leve)

- **Domínio puro** (`*/domain`): `Money`, `Wallet`, `WalletLedgerEntry`,
  `WagerTransaction`, `WagerProcessor`, eventos, Inbox/Outbox. Sem NestJS, sem ORM,
  sem `Date.now()` direto (há portas `Clock` e `IdGenerator`). Construtores
  privados + factories (`create`/`from`/`rehydrate`); `rehydrate` **não** revalida
  transições, apenas reconstrói estado persistido.
- **Aplicação** (`*/application`): use cases que orquestram a unidade de trabalho.
  O `SubmitWagerTransactionUseCase` é **o mesmo** para HTTP e SQS.
- **Infraestrutura** (`*/infrastructure`, `database`, `messaging`): repositórios,
  mappers domínio↔registro, SQS, migrations.
- **HTTP** (`*/http`, `http`): controllers, DTOs validados, filtro de erros.

Portas explícitas: `Clock`, `IdGenerator`, `TransactionRunner`, `MetricsPort`,
`ProviderIdentityPort`. Facilitam teste e troca de implementação.

## 3. Correção financeira

- **`Money`** encapsula um `Decimal` (decimal.js) e a moeda. Imutável. A entrada
  é uma *string decimal* com escala fixa 2; valores com mais casas são
  **rejeitados, nunca arredondados** (regex `^(0|[1-9]\d*)\.\d{2}$`). `NaN`,
  `Infinity`, notação científica, vazio e negativos no contrato de entrada são
  rejeitados. **Nenhum `number` toca o caminho do dinheiro.**
- Na persistência: colunas `numeric(20,2)`; o driver devolve string, que entra
  direto em `Money.from`.
- **Ledger** imutável e append-only. Cada lançamento valida a aritmética
  (`balanceBefore ± money === balanceAfter`) na factory e no `CHECK` do schema.
  `LOSS` e transações `REJECTED` não geram lançamento.
- **Reconciliação** (`POST /wallets/:id/reconciliation`) recomputa o saldo pelo
  ledger com `Decimal` (tolera anomalias de propósito — é o que ela existe para
  detectar), compara com o saldo materializado, **não corrige em silêncio**: loga
  em `error`, incrementa `wallet_reconciliation_divergences_total` e sinaliza
  `consistent: false`.

## 4. Concorrência — a unidade é a `walletId`

**Estratégia: lock pessimista por linha de wallet** (`SELECT … FOR UPDATE`) dentro
de uma transação `READ COMMITTED`, com defesa em profundidade:

1. o `FOR UPDATE` serializa os escritores da *mesma* wallet; wallets diferentes
   seguem em paralelo (não há lock global — requisito 6);
2. `CHECK (balance_amount >= 0)` impede saldo negativo mesmo diante de um bug;
3. trigger de versão: `version` só muda junto com o saldo, e por +1;
4. trigger diferido (no commit) garante a relação 1:1 saldo↔ledger.

**Por que pessimista e não otimista:** em *hot wallets* o otimista degrada em
retries/thrash; o lock por linha dá vazão estável e correção simples. Ainda assim,
o `TransactionRunner` reexecuta a unidade inteira em erros **transitórios**
(`40001` serialization, `40P01` deadlock, `55P03` lock timeout, falhas de conexão)
com backoff + jitter e limite — ver
[`transaction-runner.ts`](src/database/transaction-runner.ts) e o classificador de
SQLSTATE em [`pg-error.ts`](src/database/pg-error.ts).

**Ordem de lock (evita deadlock):** sempre **wallet primeiro, depois a linha da
transação**. O resolver de referências pega a wallet com `FOR UPDATE` e a linha
pendente com `FOR UPDATE SKIP LOCKED`, na mesma ordem.

`lock_timeout`, `statement_timeout` e `idle_in_transaction_session_timeout` são
definidos por conexão (via `options` do libpq) para não travar indefinidamente.

### Cenário obrigatório (saldo 100, duas apostas de 80)

As duas transações disputam o `FOR UPDATE` da wallet. A primeira debita e commita
(libera o lock); a segunda adquire o lock, revê o saldo (20) e é **rejeitada** por
saldo insuficiente. Resultado: 1 `PROCESSED`, 1 `REJECTED`, saldo 20.00, **um**
débito no ledger, nenhum retry duplica o débito.

## 5. Idempotência

- **`Idempotency-Key`** (header, obrigatório no HTTP) é a fonte da verdade;
  default recomendado `"{providerId}:{externalTransactionId}"`.
- **`payloadHash`** = SHA-256 do **JSON canônico** (chaves ordenadas
  recursivamente, sem espaços, `undefined` omitido) do **subconjunto de negócio**:
  `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
  money{amount,currency}, referenceExternalTransactionId?`. O header e metadados de
  transporte **não** entram no hash. Implementação em
  [`canonical-json.ts`](src/shared/domain/canonical-json.ts).
- **Replay vs. conflito:** mesma key + mesmo hash → devolve o resultado original
  (`idempotentReplay: true`), incluindo o saldo observado na época; mesma key +
  hash diferente → **409 conflito**, nunca replay.
- **Corrida de submit:** a verificação de idempotência é refeita **sob o lock da
  wallet** (toda key aponta para a mesma wallet), então 50 envios paralelos da
  mesma aposta resultam em 1 efeito e 49 replays — sem violação de unicidade.
- A unicidade também está no schema: `UNIQUE(idempotency_key)` e
  `UNIQUE(provider_id, external_transaction_id)`.

## 6. Mensageria, atomicidade e recuperação de falhas

Numa **única transação SQL** participam: o registro de **inbox** (quando a origem
é SQS), a alteração de saldo, o lançamento no ledger, a `WagerTransaction` e os
eventos na **outbox**. Ou tudo commita junto, ou nada. **Nenhum evento é publicado
antes do commit** — eles só vão para a outbox.

### Inbox (dedup de entrega)

`INSERT … ON CONFLICT DO NOTHING` em `(consumer_name, message_id)`. Se a linha já
existia, é entrega duplicada → devolve o resultado anterior e dá `ack`. O
`ON CONFLICT` serializa até entregas concorrentes do mesmo `messageId`.

### Outbox transacional + publisher

Um worker reivindica lotes com **lease**:
`UPDATE … SET locked_until=…, locked_by=… WHERE id IN (SELECT … WHERE published_at
IS NULL AND next_attempt_at<=now() AND lease expirado ORDER BY sequence LIMIT N FOR
UPDATE SKIP LOCKED)`. Vários publishers coexistem sem brigar pelas mesmas linhas.
O evento é **publicado no SQS antes** de marcar `published_at`. Cenário coberto:

1. Postgres commita; 2. o processo morre antes de publicar; 3. o lease expira e
outra instância assume; 4. o evento é publicado; 5. a publicação duplicada é segura
— o consumidor deduplica por `eventId` (`MessageDeduplicationId` na fila FIFO).

### Consumer SQS

Reusa o mesmo use case, dedup por inbox, `ack` **somente após o commit**.
Classificação de erros:

- **negócio / replay / duplicata** → `ack` (a rejeição é um resultado normal, não
  exceção);
- **transitório** → `ChangeMessageVisibility` com backoff → redelivery; após o
  limite, vai para a DLQ;
- **permanente** (payload malformado, tipo desconhecido, conflito de idempotência,
  wallet inexistente) → `SendMessage` explícito para a **DLQ** com atributo
  `errorCode`, depois `ack`.

`RedrivePolicy` com `maxReceiveCount` é um *backstop*, não a garantia. `SIGTERM`
(via `enableShutdownHooks`) para o polling e devolve a visibilidade das mensagens
em andamento. A *flag* `CHAOS_CRASH_AFTER_COMMIT` (teste) simula morte após commit
e antes do `ack` — a redelivery não duplica efeito (a inbox deduplica).

## 7. Referências fora de ordem

`REFUND`/`ROLLBACK` (e `WIN` opcionalmente) podem chegar antes da transação
referenciada. Nesse caso a transação é persistida como `PENDING_REFERENCE` e um
**worker agendado** a reprocessa com backoff exponencial + jitter. Esgotado o
orçamento de tentativas (`PENDING_REFERENCE_MAX_ATTEMPTS`, padrão 10 ≈ 7 min), vira
`REJECTED` com `REFERENCE_NOT_FOUND` e evento correspondente. Há também um "nudge":
ao processar uma transação, dependentes que a referenciam têm o
`next_reference_attempt_at` adiantado — otimização; a garantia continua sendo o
worker.

## 8. Máquina de estados da `WagerTransaction`

```
PENDING ──▶ PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
PENDING_REFERENCE ──▶ PROCESSED | REJECTED | FAILED
```

`PROCESSED`, `REJECTED`, `FAILED` são **terminais**: congelam a transação. Tentar
transicionar de um terminal é erro de programação (`InvalidTransactionStateError`),
não caminho de negócio — e também é bloqueado por trigger no schema
(`status` terminal é imutável; colunas de negócio imutáveis).

## 9. Taxonomia de `failureCode`

Códigos estáveis e legíveis por máquina, cada um com `retryable`/`fixPayload` na
documentação ([`failure-code.ts`](src/wagering/domain/failure-code.ts)):

| Código | Situação |
|---|---|
| `INSUFFICIENT_FUNDS` | aposta sem saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão tornaria o saldo negativo (código **distinto** da aposta sem saldo — situações operacionalmente diferentes) |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet |
| `WALLET_PLAYER_MISMATCH` | `walletId` não pertence ao `playerId` |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro da janela |
| `REFERENCE_MISMATCH` | referência de outro player/wallet/moeda/rodada |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo da referência não pode ser revertido por essa operação |
| `REFERENCE_NOT_PROCESSED` | referência existe mas não está `PROCESSED` |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência (sem reversão parcial) |
| `ALREADY_REVERSED` | referência já revertida |
| `PROCESSING_RETRIES_EXHAUSTED` | falha permanente de infraestrutura (`FAILED`) |

## 10. Mapeamento HTTP

Um único `ProblemDetailsFilter` emite `application/problem+json` com `code` +
`retryable`. A API distingue com clareza e de forma consistente:

| Situação | HTTP |
|---|---|
| processado (novo ou replay) | **200** (`idempotentReplay` diferencia) |
| aceito, pendente de referência | **202** |
| rejeição por regra de negócio | **422** (corpo com `failureCode` e saldo) |
| payload inválido / falta `Idempotency-Key` | **400** |
| conflito de idempotência / wallet duplicada | **409** |
| não encontrado | **404** |
| falha transitória de infraestrutura | **503** (+ `Retry-After`) |
| inesperado | **500** |

## 11. ORM e estratégia transacional

**MikroORM 6** (preferência do desafio) para configuração, pool, request context,
migrations versionadas/reversíveis e acesso a dados. A fronteira de unidade de
trabalho é `em.transactional()` (`READ COMMITTED`); o lock da wallet usa
`LockMode.PESSIMISTIC_WRITE`; operações pontuais que o ORM não expressa bem
(upsert de inbox com `ON CONFLICT`, claim da outbox com `FOR UPDATE SKIP LOCKED`)
usam SQL explícito via `em.execute`, dentro da mesma transação. O domínio não
depende de tipos do ORM: *records* (`EntitySchema`) são mapeados para o domínio por
*mappers* que chamam `rehydrate`. Dinheiro é `decimal`/string ponta a ponta.

A `version` da wallet é gerenciada pelo **domínio** (incrementa só quando o saldo
muda), não pelo versionamento automático do ORM — por isso não usamos o *optimistic
lock* embutido, que incrementaria a cada flush.

## 12. Autenticação (não implementada — por desenho)

Conforme a seção 2 do enunciado, autenticação **não pontua** e não deve competir
com o essencial. Está presente como **ponto de extensão explícito**:
`ProviderAuthGuard` (no-op, global, exceto health/metrics) +
`ProviderIdentityPort`. A mensagem da fila é tratada como canal interno confiável,
mas a identidade do provedor contida nela continua sujeita às validações de domínio
(`WALLET_PLAYER_MISMATCH`, checagens de referência por provider).

**Desenho que eu adotaria:** um IdP externo (Keycloak) com um *client* OIDC por
provedor usando *client-credentials*. O guard validaria o *access token* (JWKS) e
exigiria que o `azp`/`client_id` do token correspondesse ao `providerId` do corpo.
Nenhuma tabela própria de usuários/senhas. A troca é só reimplementar
`ProviderIdentityPort` e fazer o guard rejeitar — sem mudar controllers.

## 13. Observabilidade

- Logs **JSON** (pino) com `correlationId`; headers sensíveis e bodies são
  redigidos (sem dados financeiros completos).
- Métricas Prometheus em `/metrics`: `wager_transactions_total{kind,status}`,
  `idempotency_duplicates_total`, `retries_total`, `dlq_messages_total`,
  `lock_conflicts_total`, `outbox_lag_seconds`/`outbox_pending`,
  `wager_processing_duration_seconds`, `wallet_reconciliation_divergences_total`.
- Health separados: `/health/live` (processo) e `/health/ready` (Postgres + SQS).

## 14. Interpretações adotadas (documentadas)

- **Reversão única por qualquer tipo:** uma referência pode ser revertida **no
  máximo uma vez por qualquer operação de reversão** (REFUND *ou* ROLLBACK).
  Mais estrito que "uma vez por tipo"; impede que uma `BET` seja ao mesmo tempo
  reembolsada e revertida, creditando o jogador duas vezes. Imposto por índice
  único parcial em `(reference_transaction_id) WHERE kind IN (REFUND,ROLLBACK) AND
  status=PROCESSED`.
- **Referência presente mas não `PROCESSED`** → `REFERENCE_NOT_PROCESSED`
  (rejeita). O caso fora de ordem que tratamos com espera é o de referência
  **ausente**.
- **`WIN` com referência** é um vínculo informativo (mesmo player/wallet/moeda/
  rodada), sem regra de valor/único; `WIN` não exige referência.
- **Wallet inexistente** no submit → erro (não persiste a transação); pela fila,
  vai para a DLQ como permanente.
- **`version` começa em 1** após a abertura (o crédito de `OPENING` faz parte da
  criação, no mesmo commit); abre em 0 sem lançamento quando o saldo inicial é 0.

## 15. Limitações e trade-offs

- **Ordenação estrita por agregado entre publishers** não é garantida (vários
  publishers, entrega at-least-once). Mitigação: `walletVersion` no payload permite
  ao consumidor ordenar; o id de evento deduplica.
- **MiniStack** no lugar do LocalStack porque o Community passou a exigir token.
  O código só depende de `AWS_ENDPOINT_URL`; trocar o emulador é mudar a env.
- Propagação de **todos** os campos (`messageId`, `transactionId`, `walletId`) via
  `AsyncLocalStorage` para *todas* as linhas de log foi deixada como evolução; hoje
  o `correlationId` é propagado no HTTP e os campos relevantes entram nos logs de
  cada componente.
- A relação 1:1 saldo↔ledger usa *constraint triggers* diferidas; isso assume
  **no máximo um lançamento por wallet por transação SQL**, que é exatamente o
  contrato do domínio.
