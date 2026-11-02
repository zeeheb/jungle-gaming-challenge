import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module, type FactoryProvider, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { UNIT_OF_WORK, type UnitOfWork } from './application/unit-of-work';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
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
import { SqsModule } from './infrastructure/messaging/sqs.module';

// Use cases are plain classes with no Nest decorators: this module is the only
// place that knows how they are put together.
function useCase<T>(type: new (unitOfWork: UnitOfWork) => T): FactoryProvider<T> {
  return { provide: type, useFactory: (unitOfWork: UnitOfWork) => new type(unitOfWork), inject: [UNIT_OF_WORK] };
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
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationIdMiddleware).forRoutes(WalletsController, WageringController);
  }
}
