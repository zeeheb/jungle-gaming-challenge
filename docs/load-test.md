# Teste de carga

`bun run test:load` dispara apostas por HTTP contra uma instância em execução e imprime a tabela abaixo. Os parâmetros são opcionais: `--url`, `--duration` (s), `--concurrency`, `--wallets`, `--hot`, `--hot-share` e `--replay-share`.

## Ambiente da execução registrada (2026-11-02)

- **Máquina:** AMD Ryzen 7 5700X3D (8 núcleos / 16 threads), 28 GB de RAM, Windows 10.
- **Docker Desktop 28.3.2** (VM Linux com 16 CPUs e 14 GB).
- **Tudo em contêineres, com `docker compose --profile app up`:** PostgreSQL 18, MiniStack, 1 `api` (recebe o HTTP) e 2 `worker`, ou seja, 3 instâncias consumindo filas, publicando a outbox e rodando o worker de referências. Configuração padrão: pool de 10 conexões por instância, lote da outbox de 10 eventos.
- **Cliente:** o script rodando no Windows (fora do Docker), atravessando a rede do Docker Desktop.

## Metodologia

- **Preparação:** 200 wallets com saldo alto, para que nenhuma aposta seja rejeitada por saldo, e 4 wallets "quentes".
- **Carga:** 32 clientes em laço fechado (cada um manda a próxima requisição assim que recebe a resposta), durante 30 s.
- **Mistura:** apostas de 1,00, com 20% delas mirando as 4 wallets quentes (para provocar disputa de lock na mesma linha) e 5% sendo reenvios idênticos de apostas já feitas (replays).
- **Métricas do sistema:** conflitos de lock e duplicatas vêm do `/metrics` (diferença entre antes e depois). O lag da outbox é amostrado a cada 500 ms durante a carga, e depois se mede quanto tempo o relay leva para zerar o backlog.
- **Latência:** medida no cliente, da requisição até a resposta completa.

## Resultado

| Métrica | Valor |
|---|---|
| Duração / concorrência | 33,4 s / 32 clientes |
| Requisições | 11.339 (5% replays) |
| Throughput | **339 req/s** |
| Latência p50 / p95 / p99 / máx. | 73 ms / 102 ms / 686 ms / 3.657 ms |
| Status HTTP | 200: 11.339 |
| Taxa de erro (5xx + rede) | **0,00%** |
| Conflitos de lock (timeout, deadlock) | 0 |
| Duplicatas respondidas do armazenamento | 586 |
| Outbox: máx. pendentes / máx. lag durante a carga | 6.302 eventos / 11,1 s |
| Outbox: tempo para zerar depois da carga | 19,0 s |

## Análise

- **Correção sob carga:** nenhuma resposta 5xx, nenhum conflito de lock e todos os replays respondidos do armazenamento. Depois da carga, a reconciliação das wallets continua consistente. O teste mede vazão; a correção sob concorrência é provada pelos testes de concorrência e de caos.
- **A cauda da latência (p99 de 686 ms, máx. de 3,6 s) vem da fila nas wallets quentes, e era esperada.** Com 20% das apostas em 4 wallets, as requisições de uma mesma wallet esperam o lock umas das outras: é a serialização que garante a correção. Também pesa a espera por conexão (32 clientes para um pool de 10 na instância `api`). Nenhuma chegou ao `lock_timeout` de 5 s.
- **O gargalo é o relay da outbox, e não o caminho do dinheiro.** Cada aposta gera 2 eventos (cerca de 680 eventos/s). Os 3 relays, com lote de 10 e uma chamada `SendMessageBatch` por vez, publicaram em torno de 500/s, e o backlog chegou a 6,3 mil eventos (11 s de atraso). Nada se perde: o relay zerou tudo 19 s depois do fim da carga. Mas, sob carga contínua, os consumidores de eventos ficariam atrasados.
- **Próximos passos, se fosse para produção:**
  1. Reservar lotes maiores (por exemplo, 100) e mandar os `SendMessageBatch` em paralelo, mantendo a ordem por grupo.
  2. Escalar os relays de forma independente da API (`OUTBOX_RELAY_ENABLED`).
  3. Alertar em `wagering_outbox_lag_seconds`.
- **Limites desta medição:**
  - O cliente divide a máquina com o banco e a fila.
  - O MiniStack não tem a latência de rede do SQS real.
  - O Docker Desktop no Windows acrescenta uma camada de rede.
  - Os números servem para comparar versões e achar gargalos, não como capacidade de produção.
