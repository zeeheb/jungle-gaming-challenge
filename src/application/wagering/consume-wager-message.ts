import type { WagerPayload } from '../../domain/wagering/payload-hash';
import { InvalidWagerTransactionError } from '../../domain/wagering/wager-transaction';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  MessageConflictError,
  TransientFailureError,
  WalletNotFoundError,
} from '../errors';
import { dateText, objectInput, requiredText } from '../input';
import type { ProcessWagerResult, ProcessWagerTransaction } from './process-wager-transaction';
import { parseIdempotencyKey, parseWagerRequest } from './wager-request';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/** Name under which this service records the messages it consumed (inbox key). */
export const WAGER_CONSUMER_NAME = 'wager-transactions';

export interface WagerMessage {
  /** The producer's id, stable across redeliveries and re-sends; the broker's own id is not. */
  messageId: string;
  occurredAt: Date;
  idempotencyKey: string;
  payload: WagerPayload;
}

export function parseWagerMessage(body: string): WagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidRequestError('Message body is not valid JSON');
  }
  const envelope = objectInput(parsed, 'message');
  const type = requiredText(envelope, 'type');
  if (type !== WAGER_MESSAGE_TYPE) {
    throw new InvalidRequestError(`Unsupported message type ${type}`);
  }
  const data = objectInput(envelope['data'], 'data');

  return {
    messageId: requiredText(envelope, 'messageId'),
    occurredAt: dateText(envelope, 'occurredAt'),
    idempotencyKey: parseIdempotencyKey(data['idempotencyKey'], 'data.idempotencyKey'),
    payload: parseWagerRequest(data),
  };
}

/**
 * What the consumer must do with a message:
 * - ack: the outcome is final (processed, rejected, pending reference, or a duplicate);
 * - dead-letter: it will never succeed as it is, retrying is pointless;
 * - retry: something temporary failed; the same message may succeed later.
 */
export type MessageOutcome =
  | { action: 'ack'; result: ProcessWagerResult }
  | { action: 'dead-letter' | 'retry'; code: string; reason: string };

type ErrorWithCode = abstract new (...args: never[]) => Error & { code: string };

const PERMANENT_ERRORS: readonly ErrorWithCode[] = [
  InvalidRequestError,
  InvalidWagerTransactionError,
  WalletNotFoundError,
  IdempotencyConflictError,
  MessageConflictError,
];

/**
 * Queue entry point for provider transactions. It runs the very same use case
 * as POST /wagering/transactions; the only addition is the inbox receipt.
 */
export class ConsumeWagerMessage {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly consumerName = WAGER_CONSUMER_NAME,
  ) {}

  /** Errors that fit no category are rethrown; the consumer retries them, up to its attempt limit. */
  async execute(body: string): Promise<MessageOutcome> {
    try {
      const message = parseWagerMessage(body);
      const result = await this.processWager.execute({
        idempotencyKey: message.idempotencyKey,
        payload: message.payload,
        // the message format carries no correlation id: the message itself starts the chain
        correlationId: message.messageId,
        causationId: message.messageId,
        inbox: { consumerName: this.consumerName, messageId: message.messageId },
      });
      // A business rejection is an outcome like any other: it is stored and acked.
      return { action: 'ack', result };
    } catch (error) {
      for (const permanent of PERMANENT_ERRORS) {
        if (error instanceof permanent) {
          return { action: 'dead-letter', code: error.code, reason: error.message };
        }
      }
      if (error instanceof TransientFailureError) {
        return { action: 'retry', code: error.code, reason: error.message };
      }
      throw error;
    }
  }
}
