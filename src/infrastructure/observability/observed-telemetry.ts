import { Logger } from '@nestjs/common';
import type { Duplicate, Entrypoint, Telemetry } from '../../application/telemetry';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WalletReconciliation } from '../../domain/wallet/wallet-reconciliation';
import type { WageringMetrics } from './wagering-metrics';

/**
 * The Telemetry port turned into structured logs and Prometheus metrics. Log
 * lines carry identifiers only (transaction, wallet, provider, message,
 * correlation): no amounts, balances or player ids. Anyone who needs the
 * money details looks the transaction up by its id.
 */
export class ObservedTelemetry implements Telemetry {
  private readonly logger = new Logger('Wagering');

  constructor(private readonly metrics: WageringMetrics) {}

  submissionAnswered(event: {
    transaction: WagerTransaction;
    entrypoint: Entrypoint;
    duplicate: Duplicate;
    durationMs: number;
    correlationId: string;
    messageId?: string | undefined;
  }): void {
    const { transaction, entrypoint, duplicate } = event;
    this.metrics.processingDuration.observe({ entrypoint }, event.durationMs / 1_000);
    if (duplicate === 'none') {
      this.metrics.transactions.inc({ entrypoint, kind: transaction.kind, status: transaction.status });
    } else {
      this.metrics.duplicates.inc({ type: duplicate });
    }

    this.logger.log({
      msg: duplicate === 'none' ? 'transaction decided' : 'duplicate answered with the stored outcome',
      ...identifiers(transaction),
      status: transaction.status,
      failureCode: transaction.failureCode,
      duplicate,
      entrypoint,
      correlationId: event.correlationId,
      messageId: event.messageId,
      durationMs: Math.round(event.durationMs),
    });
  }

  idempotencyConflict(event: { providerId: string; externalTransactionId: string; entrypoint: Entrypoint }): void {
    this.metrics.idempotencyConflicts.inc({ entrypoint: event.entrypoint });
    this.logger.warn({ msg: 'idempotency conflict', ...event });
  }

  referenceRetried({ transaction }: { transaction: WagerTransaction }): void {
    this.metrics.referenceRetries.inc({ status: transaction.status });
    this.logger.log({
      msg: 'pending reference looked up again',
      ...identifiers(transaction),
      status: transaction.status,
      failureCode: transaction.failureCode,
      referenceAttempts: transaction.referenceAttempts,
      correlationId: transaction.correlationId,
    });
  }

  walletReconciled(reconciliation: WalletReconciliation): void {
    const consistent = reconciliation.isConsistent();
    this.metrics.reconciliations.inc({ result: consistent ? 'consistent' : 'inconsistent' });
    if (!consistent) {
      // the difference is the one amount worth logging: it is what someone must investigate
      this.logger.error({
        msg: 'wallet balance does not match its ledger',
        walletId: reconciliation.walletId,
        difference: reconciliation.difference.toString(),
        checkedEntries: reconciliation.checkedEntries,
      });
    }
  }
}

function identifiers(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    kind: transaction.kind,
  };
}
