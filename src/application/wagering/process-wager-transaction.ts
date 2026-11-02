import type { EventContext } from '../../domain/events/wagering-events';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { newId } from '../../domain/shared/id';
import { computePayloadHash, type WagerPayload } from '../../domain/wagering/payload-hash';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import {
  DuplicateTransactionError,
  IdempotencyConflictError,
  MessageConflictError,
  WalletNotFoundError,
} from '../errors';
import type { InboxRepository, Repositories, UnitOfWork, WagerTransactionRepository } from '../unit-of-work';
import { settleAndRecord } from './settlement';

/** Identifies the queue message that carried the request. */
export interface InboxReceipt {
  consumerName: string;
  messageId: string;
}

export interface ProcessWagerCommand {
  idempotencyKey: string;
  payload: WagerPayload;
  correlationId: string;
  /** Id of the message that carried the request, when there is one. */
  causationId?: string | undefined;
  /** Present for queue messages: the inbox row is written in the same transaction as the effects. */
  inbox?: InboxReceipt | undefined;
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
      correlationId: command.correlationId,
    });
    const context: EventContext = { correlationId: command.correlationId, causationId: command.causationId, occurredAt: at };

    try {
      return await this.unitOfWork.run((repositories) => this.settle(repositories, incoming, context, command.inbox));
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

  private async settle(
    repositories: Repositories,
    incoming: WagerTransaction,
    context: EventContext,
    receipt: InboxReceipt | undefined,
  ) {
    const { wallets, transactions } = repositories;

    const wallet = await wallets.findByIdForUpdate(incoming.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(incoming.walletId);
    }

    if (receipt) {
      await recordInInbox(repositories.inbox, receipt, incoming, context.occurredAt);
    }

    // Looked up only now, holding the lock: a duplicate that was in flight on
    // this wallet has committed by now, and READ COMMITTED lets us see it.
    const existing = await findExisting(transactions, incoming);
    if (existing) {
      return replayOrConflict(existing, incoming);
    }

    await settleAndRecord(repositories, wallet, incoming, context, { isNew: true });
    return { transaction: incoming, replay: false };
  }
}

/**
 * A message seen before was committed together with its effects, so the
 * transaction lookup that follows turns it into a replay. Only a new message
 * gets an inbox row. Two deliveries of one message name the same wallet, so
 * the wallet lock already makes them take turns here.
 */
async function recordInInbox(
  inbox: InboxRepository,
  receipt: InboxReceipt,
  incoming: WagerTransaction,
  at: Date,
): Promise<void> {
  const seen = await inbox.find(receipt.consumerName, receipt.messageId);
  if (seen) {
    if (seen.payloadHash !== incoming.payloadHash) {
      throw new MessageConflictError(`Message ${receipt.messageId} was already consumed with a different payload`);
    }
    return;
  }
  const message = InboxMessage.receive({ ...receipt, payloadHash: incoming.payloadHash, receivedAt: at });
  message.markProcessed(at);
  inbox.add(message);
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
