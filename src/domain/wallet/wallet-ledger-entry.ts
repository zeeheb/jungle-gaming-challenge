import { DomainError } from '../shared/domain-error';
import type { Money } from '../shared/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  /** Wallet version this entry produced. Versions form a gapless sequence per wallet. */
  walletVersion: number;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

/**
 * One line of a wallet's statement. There are no setters and no transitions:
 * once created, an entry can only be read. Corrections are new entries.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly walletVersion: number,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);

    if (!entry.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be positive');
    }
    if (entry.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger entry cannot leave a negative balance');
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(`Unbalanced ${entry.direction} entry for transaction ${entry.transactionId}`);
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.walletVersion,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** The entry's effect on the balance: positive for credits, negative for debits. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
