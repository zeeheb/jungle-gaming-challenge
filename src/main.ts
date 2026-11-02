import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';
import { JsonLogger } from './infrastructure/observability/json-logger';

if (!JsonLogger.isLevel(env.logLevel)) {
  throw new Error(`LOG_LEVEL must be one of debug, info, warn, error; got "${env.logLevel}"`);
}

const app = await NestFactory.create(AppModule, { logger: new JsonLogger(env.logLevel) });
app.enableShutdownHooks();
await app.listen(env.port);
