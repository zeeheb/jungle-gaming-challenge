# Distributed Wagering Processor

Serviço de carteira para apostas que continua correto quando as mensagens chegam **duplicadas**, **fora de ordem** ou **ao mesmo tempo**, com **várias instâncias** e com **quedas** no meio do processamento. Solução do [desafio técnico da Jungle Gaming](https://github.com/junglegaming/backend-challenge).

**Stack:** Bun 1.4, TypeScript (estrito), NestJS 12, PostgreSQL 18, MikroORM 7, SQS (MiniStack) e Docker Compose.

As decisões, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md). Este arquivo explica como rodar.

## Requisitos

- Docker e Docker Compose
- [Bun](https://bun.sh) 1.4 (só para rodar fora do Docker e para os testes)

## Subindo

**Desenvolvimento** (PostgreSQL e MiniStack em contêineres, aplicação local):

```bash
docker compose up -d --wait
```

```bash
bun install
```

```bash
bun run migration:up
```

```bash
bun run dev
```

A API sobe em `http://localhost:3000`. O MiniStack cria as filas (`wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`) ao iniciar.

**Tudo em contêineres:** migração + 1 `api` + 2 `worker`, ou seja, três instâncias do mesmo serviço:

```bash
docker compose --profile app up -d --build --wait
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun run start` | API + consumidor SQS + relay da outbox + worker de referências pendentes |
| `bun run typecheck` | TypeScript estrito, sem emitir arquivos |
| `bun run test` | Todos os testes (unidade, integração e caos), cerca de 20 s |
| `bun run test:unit` | Domínio puro: sem banco e sem fila |
| `bun run test:integration` | Contra PostgreSQL e MiniStack reais (requer `docker compose up`) |
| `bun run test:chaos` | Várias instâncias reais (`bun src/main.ts`) mortas com `SIGKILL` |
| `bun run test:load` | Teste de carga contra uma instância em execução; ver [docs/load-test.md](docs/load-test.md) |
| `bun run migration:up` / `migration:down` / `migration:create <nome>` | Migrations versionadas e reversíveis |
| `bun run send-message --wallet <id> --player <id> [--kind BET] [--amount 10.00] [--copies 2]` | Publica uma aposta na fila, como um provedor faria |

Os testes de integração usam o banco `wagering_test`, criado e recriado automaticamente. Eles se recusam a rodar contra qualquer banco cujo nome não termine em `_test`.

## Usando a API

```bash
# abrir uma wallet (o saldo inicial vira uma transação OPENING com lançamento CREDIT)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

```bash
# apostar (troque <walletId>); repetir o mesmo comando devolve o mesmo resultado, com "idempotentReplay": true
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1","walletId":"<walletId>","roundId":"r1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

| Rota | |
|---|---|
| `POST /wallets` | 201; 409 se o player já tem wallet na moeda |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | extrato paginado, com cursor estável e opaco |
| `POST /wallets/:walletId/reconciliation` | saldo gravado × saldo reconstruído pelo ledger |
| `POST /wagering/transactions` | 200 processada · 202 aguardando referência · 422 rejeitada · 400 · 404 · 409 · 503 |
| `GET /wagering/transactions/:transactionId` | transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness; readiness do PostgreSQL e do SQS |
| `GET /metrics` | métricas no formato Prometheus |

O significado de cada status, os códigos de falha e as regras de idempotência estão em [ARCHITECTURE.md › API HTTP](ARCHITECTURE.md#api-http).

## Configuração

Todas as variáveis têm valores padrão que funcionam com o `docker-compose.yml`. A lista completa está em [.env.example](.env.example):
- banco e SQS;
- `DB_LOCK_TIMEOUT_MS`;
- tentativas e backoff do consumidor;
- lote e intervalo da outbox e do worker;
- `LOG_LEVEL`;
- `*_ENABLED`, para ligar e desligar cada laço em segundo plano.

## Estrutura

```
src/
  domain/          regras de negócio puras (Money, Wallet, ledger, WagerTransaction, settleWager, eventos)
  application/     casos de uso e portas (UnitOfWork, Telemetry, ProviderIdentity)
  infrastructure/  MikroORM, SQS e observabilidade
  http/            controllers, contratos de resposta, filtro de erros e guard de provedor
  workers/         laços em segundo plano e desligamento gracioso
migrations/        SQL escrito à mão: tabelas, constraints, índices e triggers
test/
  unit/            domínio, sem I/O
  integration/     HTTP, banco e filas reais
  chaos/           várias instâncias reais, quedas e reinício
scripts/           migrations, send-message, load-test
```

## Onde cada exigência do desafio está

| Exigência | Onde |
|---|---|
| Dinheiro sem `number`, escala fixa de 2 | `Money` (`bigint` de centavos), `numeric(20,2)`; [Money](ARCHITECTURE.md#money) |
| Unicidade, imutabilidade e não negatividade no schema | [Schema](ARCHITECTURE.md#schema-as-garantias-ficam-no-banco): constraints e triggers; saldo = soma do ledger garantido pelo banco |
| Concorrência entre instâncias | lock por wallet (`SELECT … FOR UPDATE`); [Concorrência](ARCHITECTURE.md#concorrência-lock-pessimista-por-wallet) |
| Idempotência persistente; payload divergente = conflito | chaves únicas no banco e hash do JSON canônico; [Fluxo](ARCHITECTURE.md#fluxo-de-processwagertransaction) |
| Inbox, retry, DLQ, ack depois do commit, SIGTERM | [Mensageria](ARCHITECTURE.md#mensageria) |
| Transactional outbox com vários publishers | [Relay da outbox](ARCHITECTURE.md#relay-da-outbox) (`FOR UPDATE SKIP LOCKED`) |
| Referência fora de ordem | [Worker de referências pendentes](ARCHITECTURE.md#worker-de-referências-pendentes) |
| Reconciliação e extrato paginado | [Extrato e reconciliação](ARCHITECTURE.md#extrato-e-reconciliação) |
| Logs JSON, métricas, health | [Observabilidade](ARCHITECTURE.md#observabilidade) |
| Autenticação | não implementada, com o ponto de extensão no código; [Autenticação](ARCHITECTURE.md#autenticação) |
| Testes obrigatórios (seção 13) | [Mapa dos testes](ARCHITECTURE.md#mapa-dos-testes-obrigatórios) |
| Teste de carga (opcional) | [docs/load-test.md](docs/load-test.md) |
