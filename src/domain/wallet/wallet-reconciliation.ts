import { Money } from '../shared/money';

export interface ReconciliationProps {
  walletId: string;
  storedBalance: Money;
  /** Sum of the wallet's CREDIT entries. */
  credits: Money;
  /** Sum of the wallet's DEBIT entries. */
  debits: Money;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger.
 * It only reports: a divergence is never corrected here, because "fixing" the
 * balance would hide whatever wrote it wrong.
 */
export class WalletReconciliation {
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  readonly difference: Money;
  readonly checkedEntries: number;

  private constructor(props: ReconciliationProps) {
    this.walletId = props.walletId;
    this.storedBalance = props.storedBalance;
    // may be negative if the ledger itself were broken: Money allows it in arithmetic
    this.calculatedBalance = Money.zero(props.storedBalance.currency).add(props.credits).subtract(props.debits);
    this.difference = this.storedBalance.subtract(this.calculatedBalance);
    this.checkedEntries = props.checkedEntries;
    Object.freeze(this);
  }

  static of(props: ReconciliationProps): WalletReconciliation {
    return new WalletReconciliation(props);
  }

  isConsistent(): boolean {
    return this.difference.isZero();
  }
}
