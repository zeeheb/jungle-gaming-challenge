import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { WalletReconciliation } from '../domain/wallet/wallet-reconciliation';

export type Entrypoint = 'http' | 'queue';

/**
 * - `none`: the outcome was decided now;
 * - `idempotency-key`: the key was seen before, the stored outcome was replayed;
 * - `message`: the same queue message came back (redelivery), recognised by the inbox.
 */
export type Duplicate = 'none' | 'idempotency-key' | 'message';

/**
 * Port for what the use cases want to have observed. The application says
 * what happened, in its own terms; the adapter decides how that becomes log
 * lines and metrics, so nothing here knows about Prometheus or a logger.
 */
export interface Telemetry {
  submissionAnswered(event: {
    transaction: WagerTransaction;
    entrypoint: Entrypoint;
    duplicate: Duplicate;
    durationMs: number;
    correlationId: string;
    messageId?: string | undefined;
  }): void;
  idempotencyConflict(event: { providerId: string; externalTransactionId: string; entrypoint: Entrypoint }): void;
  /** The pending-reference worker looked at a transaction again and stored the result. */
  referenceRetried(event: { transaction: WagerTransaction }): void;
  walletReconciled(reconciliation: WalletReconciliation): void;
}

/** Injection token for the port. */
export const TELEMETRY = Symbol('Telemetry');

/** For tests and for anything built without an adapter. */
export const NO_TELEMETRY: Telemetry = {
  submissionAnswered: () => undefined,
  idempotencyConflict: () => undefined,
  referenceRetried: () => undefined,
  walletReconciled: () => undefined,
};
