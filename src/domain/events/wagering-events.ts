import { newId } from '../shared/id';
import type { MoneyProps } from '../shared/money';
import type { FailureCode } from '../wagering/failure-code';
import type { WagerTransaction, WagerTransactionKind } from '../wagering/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { IntegrationEvent, type IntegrationEventProps } from './integration-event';

/** Tracing data carried from the request/message that caused the event. */
export interface EventContext {
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

// All events use the wallet as aggregate: it is the consistency boundary, and
// the publisher uses aggregateId as the FIFO group, so a consumer sees a
// wallet's events in the order they were committed.
function envelope<T>(walletId: string, data: T, ctx: EventContext): IntegrationEventProps<T> {
  return {
    eventId: newId(),
    aggregateId: walletId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    data,
  };
}

interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function requireDecidedAt(tx: WagerTransaction): string {
  if (!tx.processedAt) {
    throw new Error(`Transaction ${tx.id} has no outcome yet`);
  }
  return tx.processedAt.toISOString();
}

export interface WagerTransactionProcessedData extends TransactionRef {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, LOSS included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.resultingBalance) {
      throw new Error(`Transaction ${tx.id} has no resulting balance`);
    }
    return new WagerTransactionProcessed(
      envelope(
        tx.walletId,
        {
          ...transactionRef(tx),
          ...(tx.referenceTransactionId !== undefined && { referenceTransactionId: tx.referenceTransactionId }),
          balance: tx.resultingBalance.toJSON(),
          processedAt: requireDecidedAt(tx),
        },
        ctx,
      ),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionRef {
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) {
      throw new Error(`Transaction ${tx.id} was not rejected`);
    }
    return new WagerTransactionRejected(
      envelope(tx.walletId, { ...transactionRef(tx), failureCode: tx.failureCode, rejectedAt: requireDecidedAt(tx) }, ctx),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId || !tx.nextReferenceAttemptAt) {
      throw new Error(`Transaction ${tx.id} is not waiting for a reference`);
    }
    return new WagerTransactionPendingReference(
      envelope(
        tx.walletId,
        {
          ...transactionRef(tx),
          referenceExternalTransactionId: tx.referenceExternalTransactionId,
          nextAttemptAt: tx.nextReferenceAttemptAt.toISOString(),
        },
        ctx,
      ),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Only emitted when the balance actually moved. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      envelope(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: entry.walletVersion,
        },
        ctx,
      ),
    );
  }
}
