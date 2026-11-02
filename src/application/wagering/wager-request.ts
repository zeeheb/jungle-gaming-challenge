import type { WagerPayload } from '../../domain/wagering/payload-hash';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import { InvalidRequestError } from '../errors';
import { MAX_TEXT_LENGTH, moneyField, objectInput, optionalText, requiredText, uuidText } from '../input';

/** OPENING is internal: neither the API nor the queue can submit it. */
const SUBMITTABLE_KINDS: readonly string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/**
 * The business fields of a submission, the same for HTTP and SQS. Unknown
 * fields are ignored, and since they are not business fields they never
 * change the payload hash either.
 */
export function parseWagerRequest(body: unknown): WagerPayload {
  const input = objectInput(body);
  const kind = requiredText(input, 'kind');
  if (!SUBMITTABLE_KINDS.includes(kind)) {
    throw new InvalidRequestError(`kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
  }

  return {
    providerId: requiredText(input, 'providerId'),
    externalTransactionId: requiredText(input, 'externalTransactionId'),
    playerId: requiredText(input, 'playerId'),
    walletId: uuidText(input, 'walletId'),
    roundId: requiredText(input, 'roundId'),
    gameId: requiredText(input, 'gameId'),
    kind: kind as WagerTransactionKind,
    money: moneyField(input, 'money'),
    referenceExternalTransactionId: optionalText(input, 'referenceExternalTransactionId'),
  };
}

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequestError('Idempotency-Key is required');
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new InvalidRequestError(`Idempotency-Key must have at most ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}
