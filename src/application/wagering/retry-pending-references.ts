import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { TransientFailureError } from '../errors';
import { NO_TELEMETRY, type Telemetry } from '../telemetry';
import type { UnitOfWork } from '../unit-of-work';
import { settleAndRecord } from './settlement';

export interface RetryRound {
  /** Transactions found due in this round. */
  due: number;
  /** Reached their outcome: processed, rejected, or REFERENCE_NOT_FOUND after the last attempt. */
  settled: number;
  /** Reference still missing (or not final): next lookup scheduled with a longer delay. */
  waiting: number;
  /** Someone else handled it between our lookup and our lock. */
  skipped: number;
  /** The wallet stayed locked longer than the lock timeout: left for the next round. */
  busy: number;
}

type Outcome = Exclude<keyof RetryRound, 'due'>;

/**
 * The scheduled worker of section 7.1. A transaction that arrived before its
 * reference (PENDING_REFERENCE) is looked at again when its next attempt is
 * due, with exponential backoff, until the reference shows up or the
 * attempts run out, which ends in REJECTED with REFERENCE_NOT_FOUND.
 *
 * Each transaction is retried in a database transaction of its own, under its
 * wallet's lock, and read again once the lock is held: two workers (or
 * instances) that pick the same row take turns, and the second one finds it
 * already handled. Lock order is the same as everywhere else, wallet first.
 */
export class RetryPendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly batchSize: number,
    private readonly telemetry: Telemetry = NO_TELEMETRY,
  ) {}

  /** `now` decides what is due; tests pass the scheduled time instead of sleeping until it. */
  async runOnce(now: Date = new Date()): Promise<RetryRound> {
    const due = await this.unitOfWork.run(({ transactions }) =>
      transactions.findDueForReferenceRetry(now, this.batchSize),
    );

    const round: RetryRound = { due: due.length, settled: 0, waiting: 0, skipped: 0, busy: 0 };
    // Earliest first: a REFUND waiting for a BET is settled before a ROLLBACK
    // waiting for that REFUND, so a chain can resolve in a single round.
    for (const candidate of due) {
      round[await this.retry(candidate, now)] += 1;
    }
    return round;
  }

  private async retry(candidate: WagerTransaction, now: Date): Promise<Outcome> {
    try {
      const retried = await this.unitOfWork.run(async (repositories) => {
        const wallet = await repositories.wallets.findByIdForUpdate(candidate.walletId);
        // the candidate was read without any lock: only this copy counts
        const transaction = await repositories.transactions.findById(candidate.id);
        if (!wallet || !transaction?.isDueForReferenceRetry(now)) {
          return undefined;
        }

        await settleAndRecord(
          repositories,
          wallet,
          transaction,
          {
            // same trace as the request that created it (older rows fall back to its id)
            correlationId: transaction.correlationId ?? transaction.id,
            occurredAt: now,
          },
          { isNew: false },
        );
        return transaction;
      });

      if (!retried) {
        return 'skipped';
      }
      this.telemetry.referenceRetried({ transaction: retried }); // after the commit
      return retried.isTerminal() ? 'settled' : 'waiting';
    } catch (error) {
      if (error instanceof TransientFailureError) {
        return 'busy';
      }
      throw error;
    }
  }
}
