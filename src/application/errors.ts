/**
 * Outcomes of a use case that are not business decisions about a transaction:
 * the request could not even be evaluated. Each one maps to its own HTTP status.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The input does not have the shape or values the contract requires. */
export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WagerTransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

/** Same Idempotency-Key with another payload, or an externalTransactionId reused under another key. Never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** A queue message id that was already consumed comes back with another payload: a broken producer. */
export class MessageConflictError extends ApplicationError {
  readonly code = 'MESSAGE_CONFLICT';
}

/**
 * Another submission with the same idempotency key or external id committed
 * first. The use case turns it into a replay or a conflict; it only escapes
 * as is if that second lookup fails too.
 */
export class DuplicateTransactionError extends ApplicationError {
  readonly code = 'DUPLICATE_TRANSACTION';
}

/** Lock wait timeout, deadlock, lost connection... Retrying the same request is safe and may work. */
export class TransientFailureError extends ApplicationError {
  readonly code = 'TEMPORARILY_UNAVAILABLE';
}
