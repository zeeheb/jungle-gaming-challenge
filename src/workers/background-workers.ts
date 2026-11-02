import { Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { PollingLoop } from './polling-loop';

/**
 * Starts the background loops with the application and stops them on
 * shutdown (SIGTERM via enableShutdownHooks). The stop happens in
 * beforeApplicationShutdown, while the database and SQS clients are still
 * open, so a message being processed can finish and be acked.
 */
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(BackgroundWorkers.name);

  constructor(private readonly loops: readonly PollingLoop[]) {}

  onApplicationBootstrap(): void {
    for (const loop of this.loops) {
      loop.start();
    }
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    const startedAt = performance.now();
    await Promise.all(this.loops.map((loop) => loop.stop()));
    this.logger.log({ msg: 'background loops stopped', signal, durationMs: Math.round(performance.now() - startedAt) });
  }
}
