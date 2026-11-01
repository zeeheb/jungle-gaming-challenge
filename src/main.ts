import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(env.port);
