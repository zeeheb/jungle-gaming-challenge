import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  DuplicateTransactionError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransientFailureError,
  WagerTransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../application/errors';
import { ProviderMismatchError, UnauthenticatedError } from '../application/provider-identity';
import { InvalidMoneyError } from '../domain/shared/money';
import { InvalidWagerTransactionError } from '../domain/wagering/wager-transaction';
import { InvalidWalletOperationError } from '../domain/wallet/wallet';

export interface ErrorBody {
  error: { code: string; message: string };
}

type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * Every failure leaves the API through here, so a given situation gets the
 * same status on every endpoint. The status alone tells a provider what to do:
 *
 *   400  the request is malformed: fix it, resending it as is fails again
 *   401  credentials missing or invalid (once authentication is enabled)
 *   403  authenticated as one provider, acting as another
 *   404  the wallet or transaction does not exist
 *   409  clashes with what exists (Idempotency-Key reused, wallet already open)
 *   503  temporary: resending the same request is safe and may work (Retry-After)
 *   500  a bug on our side
 *
 * A business rejection is not an error: it is a stored outcome (422) and is
 * answered by the controller like any other outcome.
 */
const STATUS_BY_ERROR: ReadonlyArray<[ErrorClass, HttpStatus]> = [
  [InvalidRequestError, HttpStatus.BAD_REQUEST],
  [InvalidMoneyError, HttpStatus.BAD_REQUEST],
  [InvalidWagerTransactionError, HttpStatus.BAD_REQUEST],
  [InvalidWalletOperationError, HttpStatus.BAD_REQUEST],
  [UnauthenticatedError, HttpStatus.UNAUTHORIZED],
  [ProviderMismatchError, HttpStatus.FORBIDDEN],
  [WalletNotFoundError, HttpStatus.NOT_FOUND],
  [WagerTransactionNotFoundError, HttpStatus.NOT_FOUND],
  [IdempotencyConflictError, HttpStatus.CONFLICT],
  [DuplicateTransactionError, HttpStatus.CONFLICT],
  [WalletAlreadyExistsError, HttpStatus.CONFLICT],
  [TransientFailureError, HttpStatus.SERVICE_UNAVAILABLE],
];

const RETRY_AFTER_SECONDS = '1';

@Catch()
export class ErrorResponseFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrors');

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.describe(error);

    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }
    response.status(status).json(body);
  }

  private describe(error: unknown): { status: HttpStatus; body: ErrorBody } {
    for (const [errorClass, status] of STATUS_BY_ERROR) {
      if (error instanceof errorClass) {
        // domain validation errors have codes of their own; on the wire a malformed request is always INVALID_PAYLOAD
        const code = status === HttpStatus.BAD_REQUEST ? 'INVALID_PAYLOAD' : (error as ApplicationError).code;
        return { status, body: errorBody(code, error.message) };
      }
    }
    if (error instanceof HttpException) {
      // raised by Nest itself: unknown route, unparseable JSON body...
      const status = error.getStatus();
      const code = status === HttpStatus.BAD_REQUEST ? 'INVALID_PAYLOAD' : (HttpStatus[status] ?? 'HTTP_ERROR');
      return { status, body: errorBody(code, error.message) };
    }

    this.logger.error(error instanceof Error ? error : { msg: 'unexpected error', error: String(error) });
    // never echo internals (SQL, stack traces) to the caller
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: errorBody('INTERNAL_ERROR', 'Unexpected error') };
  }
}

const errorBody = (code: string, message: string): ErrorBody => ({ error: { code, message } });
