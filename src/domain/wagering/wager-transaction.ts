import { addMilliseconds, exponentialBackoff } from '../shared/backoff';
import { DomainError } from '../shared/domain-error';
import type { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { computePayloadHash } from './payload-hash';

export enum WagerTransactionKind {
  /** Internal: credit of the initial balance when a wallet is opened. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Accepted, not applied yet. */
  Pending = 'PENDING',
  /** Waiting for the referenced transaction to show up. */
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/**
 * How long we wait for an out-of-order reference: retries after 1s, 2s, 4s...
 * With 10 attempts the last lookup happens ~8.5 minutes after the first one.
 */
export const REFERENCE_RETRY = { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 5 * 60_000 } as const;

/** Provider id used by internal transactions (OPENING). Reserved: providers cannot use it. */
export const INTERNAL_PROVIDER_ID = 'internal';

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

const REVERSAL_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** Which kinds each kind may point to. Kinds missing here cannot carry a reference at all. */
const REFERENCEABLE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

const REQUIRED_TEXT_FIELDS = [
  'id',
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'payloadHash',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
] as const;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** The provider's id of the referenced transaction, not our internal id. */
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  /** When the transaction reached a terminal status (processed, rejected or failed). */
  processedAt?: Date | undefined;
  /** Wallet balance observed when the outcome was decided. Replays answer with it. */
  resultingBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | undefined;
}

export type ReferenceCheck =
  | { result: 'valid' }
  | { result: 'not-ready' }
  | { result: 'invalid'; code: FailureCode };

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
}

/** Moving a transaction out of a terminal status is a bug in our code, not a business outcome. */
export class InvalidTransactionStateError extends Error {
  override name = 'InvalidTransactionStateError';
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _resultingBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._resultingBalance = state.resultingBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
  }

  /** A transaction submitted by a provider. It is born PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId: reference } = props;

    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (!props[field]?.trim()) {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }
    if (REVERSAL_KINDS.has(kind) && !reference) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if (reference !== undefined && !REFERENCEABLE_KINDS[kind]) {
      throw new InvalidWagerTransactionError(`${kind} cannot reference another transaction`);
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('A transaction cannot reference itself');
    }
    // LOSS only records the outcome of the round, so a zero amount is fine there
    const amountIsValid = kind === WagerTransactionKind.Loss ? !money.isNegative() : money.isPositive();
    if (!amountIsValid) {
      throw new InvalidWagerTransactionError(
        kind === WagerTransactionKind.Loss ? 'LOSS amount cannot be negative' : `${kind} amount must be positive`,
      );
    }

    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending, referenceAttempts: 0 });
  }

  /** The internal transaction behind a wallet's initial balance. */
  static opening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    const payload = {
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: 'wallet-opening',
      gameId: 'wallet-opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
    };
    return new WagerTransaction({
      ...payload,
      id: props.id,
      idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
      payloadHash: computePayloadHash(payload),
      createdAt: props.at,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  /** Rebuilds a persisted transaction as is. Transition rules are not re-checked. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, resultingBalance: Money, at: Date): void {
    this.assertNotTerminal('markProcessed');
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionStateError(`${this.kind} ${this.id} can only be processed against its reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultingBalance = resultingBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Records one more failed lookup of the reference and schedules the next one. */
  markPendingReference(at: Date): void {
    this.assertNotTerminal('markPendingReference');
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`${this.kind} ${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    const delay = exponentialBackoff(this._referenceAttempts, REFERENCE_RETRY.baseDelayMs, REFERENCE_RETRY.maxDelayMs);
    this._nextReferenceAttemptAt = addMilliseconds(at, delay);
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultingBalance = observedBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  isProcessed(): boolean {
    return this._status === WagerTransactionStatus.Processed;
  }

  /** LOSS only records the result of the round. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** REFUND and ROLLBACK revert something, so they cannot exist without a reference. */
  requiresReference(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  hasExhaustedReferenceAttempts(): boolean {
    return this._referenceAttempts >= REFERENCE_RETRY.maxAttempts;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK direction depends on the transaction it reverts');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Credit ? LedgerDirection.Debit : LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move the balance');
    }
  }

  /**
   * Business validation of a resolved reference. Whether the reference was
   * already reverted depends on other rows, so the caller tells us.
   */
  checkReference(reference: WagerTransaction, options: { alreadyReversed: boolean }): ReferenceCheck {
    if (!reference.isTerminal()) {
      return { result: 'not-ready' };
    }
    if (!REFERENCEABLE_KINDS[this.kind]?.includes(reference.kind)) {
      return { result: 'invalid', code: FailureCode.ReferenceKindNotAllowed };
    }
    const sameContext =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId &&
      reference.money.currency === this.money.currency;
    if (!sameContext) {
      return { result: 'invalid', code: FailureCode.ReferenceMismatch };
    }
    if (!reference.isProcessed()) {
      return { result: 'invalid', code: FailureCode.ReferenceNotProcessed };
    }
    if (this.requiresReference()) {
      if (!reference.money.equals(this.money)) {
        return { result: 'invalid', code: FailureCode.ReferenceAmountMismatch };
      }
      if (options.alreadyReversed) {
        return { result: 'invalid', code: FailureCode.ReferenceAlreadyReversed };
      }
    }
    return { result: 'valid' };
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${transition} transaction ${this.id}: it is already ${this._status}`);
    }
  }
}
