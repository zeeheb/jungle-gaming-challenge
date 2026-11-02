import type { EventContext } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { settleWager } from '../../domain/wagering/settle-wager';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { Repositories } from '../unit-of-work';

/**
 * Settling a transaction is the same whether it just arrived
 * (ProcessWagerTransaction) or is picked up again later
 * (RetryPendingReferences). The caller must hold the wallet lock.
 *
 * Loads the reference, lets the domain decide, and registers everything that
 * came out of it: the transaction itself, the ledger entry and wallet when the
 * balance moved, and the events in the outbox. Reversals of a valid reference
 * live in the same wallet, so the caller's lock covers the "already reversed"
 * check too.
 */
export async function settleAndRecord(
  repositories: Repositories,
  wallet: Wallet,
  transaction: WagerTransaction,
  context: EventContext,
  options: { isNew: boolean },
): Promise<void> {
  const { wallets, transactions, ledger, outbox } = repositories;

  const reference =
    transaction.referenceExternalTransactionId === undefined
      ? undefined
      : await transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId);
  const referenceAlreadyReversed =
    reference !== undefined && transaction.requiresReference() && (await transactions.isReversed(reference.id));

  const { entry, events } = settleWager({ wallet, transaction, reference, referenceAlreadyReversed, context });

  // the transaction first: the ledger entry points to it (LedgerRepository contract)
  if (options.isNew) {
    transactions.add(transaction);
  } else {
    transactions.update(transaction);
  }
  if (entry) {
    ledger.add(entry);
    wallets.update(wallet);
  }
  for (const event of events) {
    outbox.add(OutboxMessage.enqueue(event));
  }
}
