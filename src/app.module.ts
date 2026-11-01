import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import mikroOrmConfig from './infrastructure/database/mikro-orm.config';
import { SqsModule } from './infrastructure/messaging/sqs.module';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), SqsModule],
  controllers: [HealthController],
})
export class AppModule {}
