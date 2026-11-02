import { HttpStatus } from '@nestjs/common';
import type { ProcessWagerResult } from '../application/wagering/process-wager-transaction';
import type { MoneyProps } from '../domain/shared/money';
import type { FailureCode } from '../domain/wagering/failure-code';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';

// Response contracts. Built from the domain objects explicitly, field by
// field, so a new property in the domain never leaks into the API by accident.

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function walletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

/**
 * HTTP status of a submission, decided by the stored outcome only. A replay
 * gets exactly what the first answer got.
 */
const STATUS_BY_OUTCOME: Record<WagerTransactionStatus, HttpStatus> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  // accepted and stored, but the outcome is not decided yet
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  // a business rule said no: final for this key, see failureCode
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  // gave up after infrastructure kept failing: final for this key as well
  [WagerTransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

export const httpStatusFor = (status: WagerTransactionStatus): HttpStatus => STATUS_BY_OUTCOME[status];

export interface SubmissionView {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Balance observed when the outcome was decided; absent while pending. */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export function submissionView({ transaction, replay }: ProcessWagerResult): SubmissionView {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.resultingBalance && { balance: transaction.resultingBalance.toJSON() }),
    ...(transaction.failureCode && { failureCode: transaction.failureCode }),
    idempotentReplay: replay,
  };
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  resultingBalance?: MoneyProps;
  referenceAttempts: number;
  nextReferenceAttemptAt?: string;
  createdAt: string;
  processedAt?: string;
}

export function transactionView(transaction: WagerTransaction): TransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId !== undefined && {
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    }),
    ...(transaction.referenceTransactionId !== undefined && {
      referenceTransactionId: transaction.referenceTransactionId,
    }),
    status: transaction.status,
    ...(transaction.failureCode && { failureCode: transaction.failureCode }),
    ...(transaction.resultingBalance && { resultingBalance: transaction.resultingBalance.toJSON() }),
    referenceAttempts: transaction.referenceAttempts,
    ...(transaction.nextReferenceAttemptAt && {
      nextReferenceAttemptAt: transaction.nextReferenceAttemptAt.toISOString(),
    }),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt && { processedAt: transaction.processedAt.toISOString() }),
  };
}
