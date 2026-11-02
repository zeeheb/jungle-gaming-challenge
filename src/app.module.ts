import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module, type FactoryProvider, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RelayOutbox } from './application/messaging/relay-outbox';
import { UNIT_OF_WORK, type UnitOfWork } from './application/unit-of-work';
import { ConsumeWagerMessage } from './application/wagering/consume-wager-message';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { RetryPendingReferences } from './application/wagering/retry-pending-references';
import { WagerTransactionQueries } from './application/wagering/wager-transaction-queries';
import { OpenWallet } from './application/wallets/open-wallet';
import { WalletQueries } from './application/wallets/wallet-queries';
import { env } from './config/env';
import { HealthController } from './health/health.controller';
import { correlationIdMiddleware } from './http/correlation-id';
import { ErrorResponseFilter } from './http/error-response.filter';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import mikroOrmConfig from './infrastructure/database/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/database/mikro-orm-unit-of-work';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { BackgroundWorkers } from './workers/background-workers';
import { PollingLoop } from './workers/polling-loop';

// Use cases are plain classes with no Nest decorators: this module is the only
// place that knows how they are put together.
function useCase<T>(type: new (unitOfWork: UnitOfWork) => T): FactoryProvider<T> {
  return { provide: type, useFactory: (unitOfWork: UnitOfWork) => new type(unitOfWork), inject: [UNIT_OF_WORK] };
}

const WORKER_ERROR_DELAY_MS = 1_000;

/** Every instance runs the HTTP API and, unless disabled, the three background loops. */
function backgroundLoops(
  consumer: SqsWagerConsumer,
  relay: RelayOutbox,
  pendingReferences: RetryPendingReferences,
): PollingLoop[] {
  const loops: PollingLoop[] = [];
  if (env.consumer.enabled) {
    loops.push(
      new PollingLoop({
        name: 'WagerConsumer',
        tick: (signal) => consumer.poll(signal),
        idleDelayMs: 0, // the long poll already waits for messages
        errorDelayMs: WORKER_ERROR_DELAY_MS,
      }),
    );
  }
  if (env.outbox.enabled) {
    loops.push(
      new PollingLoop({
        name: 'OutboxRelay',
        // a full batch means there is probably more waiting
        tick: async () => (await relay.relayBatch()).claimed === env.outbox.batchSize,
        idleDelayMs: env.outbox.pollIntervalMs,
        errorDelayMs: WORKER_ERROR_DELAY_MS,
      }),
    );
  }
  if (env.pendingReferences.enabled) {
    loops.push(
      new PollingLoop({
        name: 'PendingReferenceWorker',
        tick: async () => (await pendingReferences.runOnce()).due === env.pendingReferences.batchSize,
        idleDelayMs: env.pendingReferences.pollIntervalMs,
        errorDelayMs: WORKER_ERROR_DELAY_MS,
      }),
    );
  }
  return loops;
}

@Module({
  imports: [
    // Each unit of work forks its own EntityManager, so the per-request context is not needed.
    MikroOrmModule.forRoot({ ...mikroOrmConfig, registerRequestContext: false }),
    SqsModule,
  ],
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: APP_FILTER, useClass: ErrorResponseFilter },
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm, { lockTimeoutMs: env.lockTimeoutMs }),
      inject: [MikroORM],
    },
    useCase(OpenWallet),
    useCase(WalletQueries),
    useCase(ProcessWagerTransaction),
    useCase(WagerTransactionQueries),

    // messaging
    {
      provide: ConsumeWagerMessage,
      useFactory: (processWager: ProcessWagerTransaction) => new ConsumeWagerMessage(processWager),
      inject: [ProcessWagerTransaction],
    },
    {
      provide: SqsWagerConsumer,
      useFactory: (sqs: SQSClient, consume: ConsumeWagerMessage) =>
        new SqsWagerConsumer(sqs, consume, {
          ...env.consumer,
          queueName: env.sqs.transactionsQueue,
          deadLetterQueueName: env.sqs.transactionsDlq,
        }),
      inject: [SQSClient, ConsumeWagerMessage],
    },
    {
      provide: RelayOutbox,
      useFactory: (unitOfWork: UnitOfWork, sqs: SQSClient) =>
        new RelayOutbox(unitOfWork, new SqsEventPublisher(sqs, env.sqs.eventsQueue), env.outbox.batchSize),
      inject: [UNIT_OF_WORK, SQSClient],
    },
    {
      provide: RetryPendingReferences,
      useFactory: (unitOfWork: UnitOfWork) => new RetryPendingReferences(unitOfWork, env.pendingReferences.batchSize),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: BackgroundWorkers,
      useFactory: (consumer: SqsWagerConsumer, relay: RelayOutbox, pendingReferences: RetryPendingReferences) =>
        new BackgroundWorkers(backgroundLoops(consumer, relay, pendingReferences)),
      inject: [SqsWagerConsumer, RelayOutbox, RetryPendingReferences],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationIdMiddleware).forRoutes(WalletsController, WageringController);
  }
}
