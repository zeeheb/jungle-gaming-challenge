import type { EventContext } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { newId } from '../../domain/shared/id';
import { computePayloadHash, type WagerPayload } from '../../domain/wagering/payload-hash';
import { settleWager } from '../../domain/wagering/settle-wager';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { DuplicateTransactionError, IdempotencyConflictError, WalletNotFoundError } from '../errors';
import type { Repositories, UnitOfWork, WagerTransactionRepository } from '../unit-of-work';

export interface ProcessWagerCommand {
  idempotencyKey: string;
  payload: WagerPayload;
  correlationId: string;
  /** Id of the message that carried the request, when there is one. */
  causationId?: string | undefined;
}

export interface ProcessWagerResult {
  transaction: WagerTransaction;
  /** The outcome was decided by an earlier submission with the same key. */
  replay: boolean;
}

/**
 * The single entry point for provider transactions, used by HTTP and by the
 * SQS consumer alike.
 *
 * Concurrency: the wallet row is locked (SELECT ... FOR UPDATE) before anything
 * is read, so writers of the same wallet run one after the other, in any
 * number of processes, while different wallets never wait for each other.
 * Under that lock the read -> decide -> write sequence cannot interleave.
 */
export class ProcessWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const at = new Date();
    // Built (and so validated) before touching the database: a malformed
    // request never takes a lock.
    const incoming = WagerTransaction.create({
      ...command.payload,
      id: newId(),
      idempotencyKey: command.idempotencyKey,
      payloadHash: computePayloadHash(command.payload),
      createdAt: at,
    });
    const context: EventContext = { correlationId: command.correlationId, causationId: command.causationId, occurredAt: at };

    try {
      return await this.unitOfWork.run((repositories) => this.settle(repositories, incoming, context));
    } catch (error) {
      if (!(error instanceof DuplicateTransactionError)) {
        throw error;
      }
      // A submission with the same key (or external id) committed between our
      // lookup and our insert. On the same wallet the lock makes that
      // impossible, so it named another wallet, and what it stored decides
      // (in practice a conflict: the walletId is part of the payload hash).
      return this.unitOfWork.run(async ({ transactions }) => {
        const existing = await findExisting(transactions, incoming);
        if (!existing) {
          throw error;
        }
        return replayOrConflict(existing, incoming);
      });
    }
  }

  private async settle(repositories: Repositories, incoming: WagerTransaction, context: EventContext) {
    const { wallets, transactions, ledger, outbox } = repositories;

    const wallet = await wallets.findByIdForUpdate(incoming.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(incoming.walletId);
    }

    // Looked up only now, holding the lock: a duplicate that was in flight on
    // this wallet has committed by now, and READ COMMITTED lets us see it.
    const existing = await findExisting(transactions, incoming);
    if (existing) {
      return replayOrConflict(existing, incoming);
    }

    const reference =
      incoming.referenceExternalTransactionId === undefined
        ? undefined
        : await transactions.findByExternalId(incoming.providerId, incoming.referenceExternalTransactionId);
    // Reversals of the reference live in the same wallet, so the lock covers them too.
    const referenceAlreadyReversed =
      reference !== undefined && incoming.requiresReference() && (await transactions.isReversed(reference.id));

    const { entry, events } = settleWager({ wallet, transaction: incoming, reference, referenceAlreadyReversed, context });

    transactions.add(incoming);
    if (entry) {
      ledger.add(entry);
      wallets.update(wallet);
    }
    for (const event of events) {
      outbox.add(OutboxMessage.enqueue(event));
    }
    return { transaction: incoming, replay: false };
  }
}

async function findExisting(
  transactions: WagerTransactionRepository,
  incoming: WagerTransaction,
): Promise<WagerTransaction | undefined> {
  return (
    (await transactions.findByIdempotencyKey(incoming.providerId, incoming.idempotencyKey)) ??
    (await transactions.findByExternalId(incoming.providerId, incoming.externalTransactionId))
  );
}

/** Same key and same payload is a replay; anything else that collides is a conflict, never a replay. */
function replayOrConflict(existing: WagerTransaction, incoming: WagerTransaction): ProcessWagerResult {
  if (existing.idempotencyKey !== incoming.idempotencyKey) {
    throw new IdempotencyConflictError(
      `externalTransactionId ${incoming.externalTransactionId} was already submitted with another Idempotency-Key`,
    );
  }
  if (!existing.matchesPayload(incoming.payloadHash)) {
    throw new IdempotencyConflictError(
      `Idempotency-Key ${incoming.idempotencyKey} was already used with a different payload`,
    );
  }
  return { transaction: existing, replay: true };
}
