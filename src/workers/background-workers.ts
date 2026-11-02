import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { PollingLoop } from './polling-loop';

/**
 * Starts the background loops with the application and stops them on
 * shutdown (SIGTERM via enableShutdownHooks). The stop happens in
 * beforeApplicationShutdown, while the database and SQS clients are still
 * open, so a message being processed can finish and be acked.
 */
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(private readonly loops: readonly PollingLoop[]) {}

  onApplicationBootstrap(): void {
    for (const loop of this.loops) {
      loop.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.loops.map((loop) => loop.stop()));
  }
}
