import type { IntegrationEvent } from '../events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from '../events/wagering-events';
import type { Wallet } from '../wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { WagerTransactionStatus, type WagerTransaction } from './wager-transaction';

export interface SettleWagerInput {
  /** Must already be locked by the caller: this function assumes nobody else touches it. */
  wallet: Wallet;
  transaction: WagerTransaction;
  /** The referenced transaction, or undefined when it has not arrived (yet). */
  reference?: WagerTransaction | undefined;
  /** Whether `reference` already has a processed REFUND or ROLLBACK. */
  referenceAlreadyReversed?: boolean;
  context: EventContext;
}

export interface Settlement {
  /** Present only when the balance moved. */
  entry?: WalletLedgerEntry;
  events: IntegrationEvent<unknown>[];
}

/**
 * Decides what a wager transaction does to its wallet and applies it to both
 * objects in memory. Everything returned (plus the mutated wallet and
 * transaction) must be persisted in the same database transaction.
 *
 * Kept free of I/O on purpose: all the business rules can be tested without a
 * database, and the use case around it only deals with locking and storage.
 */
export function settleWager(input: SettleWagerInput): Settlement {
  const { wallet, transaction, reference, context } = input;
  const at = context.occurredAt;

  if (transaction.walletId !== wallet.id) {
    throw new Error(`Transaction ${transaction.id} does not belong to wallet ${wallet.id}`);
  }

  const reject = (code: FailureCode): Settlement => {
    transaction.reject(code, wallet.balance, at);
    return { events: [WagerTransactionRejected.from(transaction, context)] };
  };

  if (transaction.playerId !== wallet.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (transaction.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (transaction.referenceExternalTransactionId !== undefined) {
    const check = reference
      ? transaction.checkReference(reference, { alreadyReversed: input.referenceAlreadyReversed ?? false })
      : { result: 'not-ready' as const };

    if (check.result === 'invalid') {
      return reject(check.code);
    }
    if (check.result === 'not-ready') {
      const firstTime = transaction.status === WagerTransactionStatus.Pending;
      transaction.markPendingReference(at);
      if (transaction.hasExhaustedReferenceAttempts()) {
        return reject(FailureCode.ReferenceNotFound);
      }
      // retries are internal bookkeeping; only the first miss is news for consumers
      return { events: firstTime ? [WagerTransactionPendingReference.from(transaction, context)] : [] };
    }
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, wallet.balance, at);
    return { events: [WagerTransactionProcessed.from(transaction, context)] };
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    // A player without funds for a bet is routine. A reversal we cannot cover
    // (the WIN was already spent) is an operational problem: different code.
    return reject(transaction.requiresReference() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }

  const entry =
    direction === LedgerDirection.Debit
      ? wallet.debit(transaction.money, transaction.id, at)
      : wallet.credit(transaction.money, transaction.id, at);
  transaction.markProcessed(reference?.id, wallet.balance, at);

  return {
    entry,
    events: [WagerTransactionProcessed.from(transaction, context), WalletBalanceChanged.from(wallet, entry, context)],
  };
}
