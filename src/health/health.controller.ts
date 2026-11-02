import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { env } from '../config/env';

type CheckResult = { status: 'up' } | { status: 'down'; error: string };

const CHECK_TIMEOUT_MS = 2_000;

@Controller('health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgres, sqs] = await Promise.all([
      check(() => this.orm.em.getConnection().execute('select 1')),
      check(() => this.sqs.send(new GetQueueUrlCommand({ QueueName: env.sqs.transactionsQueue }))),
    ]);

    const ready = postgres.status === 'up' && sqs.status === 'up';
    // the body says which dependency is down, so it is not routed through the error filter
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }
}

async function check(probe: () => Promise<unknown>): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
  });

  try {
    await Promise.race([probe(), timeout]);
    return { status: 'up' };
  } catch (error) {
    return { status: 'down', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
