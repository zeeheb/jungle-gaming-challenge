import { describe, expect, it } from 'bun:test';
import { WalletReconciliation } from '../../src/domain/wallet/wallet-reconciliation';
import { brl } from '../support/builders';

const reconcile = (stored: string, credits: string, debits: string, checkedEntries = 2) =>
  WalletReconciliation.of({
    walletId: 'wallet-1',
    storedBalance: brl(stored),
    credits: brl(credits),
    debits: brl(debits),
    checkedEntries,
  });

describe('WalletReconciliation', () => {
  it('is consistent when the stored balance equals credits minus debits', () => {
    const result = reconcile('75.50', '100.00', '24.50');

    expect(result.calculatedBalance.toJSON()).toEqual({ amount: '75.50', currency: 'BRL' });
    expect(result.difference.isZero()).toBe(true);
    expect(result.isConsistent()).toBe(true);
  });

  it('reports a stored balance above the ledger as a positive difference', () => {
    const result = reconcile('80.00', '100.00', '25.00');

    expect(result.isConsistent()).toBe(false);
    expect(result.difference.toString()).toBe('5.00 BRL');
  });

  it('reports a stored balance below the ledger as a negative difference', () => {
    expect(reconcile('70.00', '100.00', '25.00').difference.toString()).toBe('-5.00 BRL');
  });

  it('can describe a ledger that does not even add up to a valid balance', () => {
    const result = reconcile('0.00', '10.00', '15.00');

    expect(result.calculatedBalance.toString()).toBe('-5.00 BRL');
    expect(result.isConsistent()).toBe(false);
  });

  it('treats an empty ledger as a zero balance', () => {
    expect(reconcile('0.00', '0', '0', 0).isConsistent()).toBe(true);
  });
});
