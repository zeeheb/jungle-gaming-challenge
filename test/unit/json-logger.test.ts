import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'bun:test';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { logContext } from '../../src/infrastructure/observability/log-context';
import { ObservedTelemetry } from '../../src/infrastructure/observability/observed-telemetry';
import { WageringMetrics } from '../../src/infrastructure/observability/wagering-metrics';
import { brl, wager } from '../support/builders';

function capture(level?: ConstructorParameters<typeof JsonLogger>[0]) {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger(level, (line) => lines.push(JSON.parse(line)));
  return { logger, lines };
}

afterEach(() => {
  Logger.overrideLogger(['error']);
});

describe('JsonLogger', () => {
  it('writes one JSON object per line with time, level, context and message', () => {
    const { logger, lines } = capture();

    logger.log('started', 'Bootstrap');

    expect(lines).toEqual([{ time: expect.any(String), level: 'info', context: 'Bootstrap', msg: 'started' }]);
  });

  it('merges structured messages and the fields of the current log context', () => {
    const { logger, lines } = capture();

    logContext.run({ correlationId: 'corr-1' }, () => logger.warn({ msg: 'retrying', attempt: 2 }, 'Consumer'));

    expect(lines[0]).toMatchObject({ level: 'warn', context: 'Consumer', correlationId: 'corr-1', msg: 'retrying', attempt: 2 });
  });

  it('keeps the stack Nest passes to error()', () => {
    const { logger, lines } = capture();

    logger.error('boom', 'Error: boom\n    at somewhere', 'HttpErrors');

    expect(lines[0]).toMatchObject({ level: 'error', context: 'HttpErrors', msg: 'boom', stack: 'Error: boom\n    at somewhere' });
  });

  it('drops lines below its level', () => {
    const { logger, lines } = capture('warn');

    logger.log('noise');
    logger.debug('more noise');
    logger.warn('kept');

    expect(lines.map((line) => line['msg'])).toEqual(['kept']);
  });
});

describe('ObservedTelemetry logs', () => {
  it('identify the transaction without its amounts or the player', () => {
    const { logger, lines } = capture();
    Logger.overrideLogger(logger);
    const transaction = wager({ money: brl('1234.56') });
    transaction.markProcessed(undefined, brl('8765.43'), new Date());

    new ObservedTelemetry(new WageringMetrics()).submissionAnswered({
      transaction,
      entrypoint: 'http',
      duplicate: 'none',
      durationMs: 12.3,
      correlationId: 'corr-1',
    });

    expect(lines[0]).toMatchObject({
      msg: 'transaction decided',
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      status: 'PROCESSED',
      correlationId: 'corr-1',
    });
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('1234.56');
    expect(line).not.toContain('8765.43');
    expect(line).not.toContain(transaction.playerId);
  });
});
