import { Logger } from '@nestjs/common';

export interface PollingLoopOptions {
  name: string;
  /** One round of work. Resolves true when there may be more work right away. */
  tick: (signal: AbortSignal) => Promise<boolean>;
  /** Pause after a round that found nothing to do. */
  idleDelayMs: number;
  /** Pause after a round that failed (database or broker down), so a failure does not spin. */
  errorDelayMs: number;
}

/**
 * Runs `tick` over and over in the background until stopped. Stopping never
 * cuts a round in half: the signal tells the round to wrap up, and stop()
 * resolves once it has.
 */
export class PollingLoop {
  private readonly logger: Logger;
  private readonly stopping = new AbortController();
  private running: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly options: PollingLoopOptions) {
    this.logger = new Logger(options.name);
  }

  start(): void {
    this.running ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    this.wakeUp?.();
    await this.running;
  }

  private async run(): Promise<void> {
    const { signal } = this.stopping;
    while (!signal.aborted) {
      try {
        const moreWork = await this.options.tick(signal);
        if (!moreWork) {
          await this.pause(this.options.idleDelayMs);
        }
      } catch (error) {
        if (signal.aborted) {
          break; // the round was cancelled by stop()
        }
        this.logger.error({ msg: 'round failed, pausing before the next one', error: error instanceof Error ? error.message : String(error) });
        await this.pause(this.options.errorDelayMs);
      }
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
