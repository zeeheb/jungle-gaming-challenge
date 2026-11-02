import { DomainError } from '../shared/domain-error';
import { newId } from '../shared/id';
import { CurrencyMismatchError, Money } from '../shared/money';
import { WagerTransaction } from '../wagering/wager-transaction';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidWalletOperationError extends DomainError {
  readonly code = 'INVALID_WALLET_OPERATION';
}

/** Everything that opening a wallet produces, to be persisted in one database transaction. */
export interface OpenedWallet {
  wallet: Wallet;
  /** Only present when the initial balance is positive. */
  opening?: { transaction: WagerTransaction; entry: WalletLedgerEntry };
}

/**
 * Aggregate root. The balance only changes through debit/credit, and both
 * return the ledger entry describing the change, so balance and ledger cannot
 * drift apart inside the domain.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * A new wallet is at version 1. A positive initial balance goes through the
   * same credit path as any other movement, booked against an internal OPENING
   * transaction, so the ledger explains the balance from the first cent.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
    /** Recorded on the OPENING transaction, if there is one. */
    correlationId: string;
  }): OpenedWallet {
    const { id, playerId, initialBalance, at, correlationId } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('Initial balance cannot be negative');
    }

    const currency = initialBalance.currency;
    if (initialBalance.isZero()) {
      return { wallet: new Wallet(id, playerId, currency, initialBalance, 1, at, at) };
    }

    // version 0 never leaves this method: the opening credit takes it to 1
    const wallet = new Wallet(id, playerId, currency, Money.zero(currency), 0, at, at);
    const transaction = WagerTransaction.opening({
      id: newId(),
      walletId: id,
      playerId,
      money: initialBalance,
      at,
      correlationId,
    });
    const entry = wallet.credit(initialBalance, transaction.id, at);
    transaction.markProcessed(undefined, wallet.balance, at);

    return { wallet, opening: { transaction, entry } };
  }

  /** Rebuilds a persisted wallet as is. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(`Insufficient funds in wallet ${this.id}`);
    }
    return this.move(LedgerDirection.Debit, money, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, money, transactionId, at);
  }

  // The entry is built (and validated) before touching any field, so a refused
  // movement leaves the wallet exactly as it was.
  private move(direction: LedgerDirection, money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError('Movement amount must be positive');
    }

    const balanceAfter =
      direction === LedgerDirection.Debit ? this._balance.subtract(money) : this._balance.add(money);
    const entry = WalletLedgerEntry.create({
      id: newId(),
      walletId: this.id,
      walletVersion: this._version + 1,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: at,
    });

    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
