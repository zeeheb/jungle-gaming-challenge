import { InvalidMoneyError, Money, type MoneyProps } from '../domain/shared/money';
import { InvalidRequestError } from './errors';

// Shape checks for untrusted input (HTTP body, SQS message). Shared by every
// entry point so they all reject the same things with the same messages.

export type Input = Readonly<Record<string, unknown>>;

/** Generous for any id a provider may send, small enough to keep junk out of the indexes. */
export const MAX_TEXT_LENGTH = 255;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

export function objectInput(value: unknown, what = 'body'): Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError(`${what} must be a JSON object`);
  }
  return value as Input;
}

/** Ids are opaque: no trimming or case folding, but blank strings are refused. */
export function optionalText(input: Input, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequestError(`${field} must be a non-empty string`);
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new InvalidRequestError(`${field} must have at most ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

export function requiredText(input: Input, field: string): string {
  const value = optionalText(input, field);
  if (value === undefined) {
    throw new InvalidRequestError(`${field} is required`);
  }
  return value;
}

/**
 * Lower-cased, the way PostgreSQL stores a uuid. Otherwise the same wallet
 * typed in another case would produce another payload hash.
 */
export function uuidText(input: Input, field: string): string {
  const value = requiredText(input, field);
  if (!isUuid(value)) {
    throw new InvalidRequestError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export function moneyField(input: Input, field: string): Money {
  const value = input[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError(`${field} must be an object like {"amount": "25.00", "currency": "BRL"}`);
  }
  try {
    return Money.from(value as MoneyProps);
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new InvalidRequestError(`${field}: ${error.message}`);
    }
    throw error;
  }
}
