import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/domain/shared/money';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '../../src/domain/wallet/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    walletVersion: 2,
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: new Date('2026-07-29T15:00:00Z'),
    ...overrides,
  };
}

describe('WalletLedgerEntry', () => {
  it('accepts a balanced debit', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().toJSON().amount).toBe('-25.00');
  });

  it('accepts a balanced credit', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl('75.00'), balanceAfter: brl('100.00') }),
    );

    expect(entry.signedAmount().toJSON().amount).toBe('25.00');
  });

  it('rejects arithmetic that does not add up', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl('76.00') }))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejects zero amounts: a movement that moves nothing is not a movement', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('0'), balanceBefore: brl('10.00'), balanceAfter: brl('10.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects an entry that would leave the balance negative', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl('30.00'), balanceBefore: brl('20.00'), balanceAfter: brl('20.00').subtract(brl('30.00')) }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects mixed currencies', () => {
    const usd = Money.from({ amount: '25.00', currency: 'USD' });
    expect(() => WalletLedgerEntry.create(props({ money: usd }))).toThrow(CurrencyMismatchError);
  });

  it('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('1000.00');
    }).toThrow(TypeError);
  });

  it('rehydrates persisted state without re-validating it', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('1.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
