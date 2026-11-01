import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/domain/shared/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { InsufficientFundsError, InvalidWalletOperationError, Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';
import { NOW, PLAYER_ID, WALLET_ID, brl, openWallet } from '../support/builders';

const later = new Date(NOW.getTime() + 1_000);

describe('Wallet', () => {
  describe('open', () => {
    it('books a positive initial balance as an OPENING credit and starts at version 1', () => {
      const { wallet, opening } = openWallet('1000.00');

      expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);
      expect(opening).toBeDefined();
      expect(opening!.transaction.kind).toBe(WagerTransactionKind.Opening);
      expect(opening!.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(opening!.entry).toMatchObject({
        walletId: WALLET_ID,
        walletVersion: 1,
        transactionId: opening!.transaction.id,
        direction: LedgerDirection.Credit,
      });
      expect(opening!.entry.balanceBefore.isZero()).toBe(true);
      expect(opening!.entry.balanceAfter.equals(wallet.balance)).toBe(true);
    });

    it('opens an empty wallet at version 1 without any ledger entry', () => {
      const { wallet, opening } = openWallet('0');

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
      expect(opening).toBeUndefined();
    });

    it('takes its currency from the initial balance', () => {
      const { wallet } = Wallet.open({
        id: 'w-usd',
        playerId: PLAYER_ID,
        initialBalance: Money.zero('USD'),
        at: NOW,
      });
      expect(wallet.currency).toBe('USD');
    });
  });

  describe('movements', () => {
    it('debits, bumps the version and returns the matching ledger entry', () => {
      const { wallet } = openWallet('100.00');

      const entry = wallet.debit(brl('25.00'), 'tx-1', later);

      expect(wallet.balance.toJSON().amount).toBe('75.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(later);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.walletVersion).toBe(2);
      expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
      expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    });

    it('credits', () => {
      const { wallet } = openWallet('100.00');

      const entry = wallet.credit(brl('50.00'), 'tx-1', later);

      expect(wallet.balance.toJSON().amount).toBe('150.00');
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.isBalanced()).toBe(true);
    });

    it('chains entries: each one starts where the previous ended, one version at a time', () => {
      const { wallet, opening } = openWallet('100.00');
      const entries = [
        opening!.entry,
        wallet.debit(brl('30.00'), 'tx-1', later),
        wallet.credit(brl('5.50'), 'tx-2', later),
        wallet.debit(brl('75.50'), 'tx-3', later),
      ];

      for (let i = 1; i < entries.length; i++) {
        expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
        expect(entries[i]!.walletVersion).toBe(entries[i - 1]!.walletVersion + 1);
      }
      const fromLedger = entries.reduce((sum, entry) => sum.add(entry.signedAmount()), Money.zero('BRL'));
      expect(fromLedger.equals(wallet.balance)).toBe(true);
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('allows debiting the whole balance', () => {
      const { wallet } = openWallet('80.00');
      wallet.debit(brl('80.00'), 'tx-1', later);
      expect(wallet.balance.isZero()).toBe(true);
    });
  });

  describe('invariants', () => {
    it('never goes negative and stays untouched when a debit is refused', () => {
      const { wallet } = openWallet('100.00');

      expect(wallet.canDebit(brl('100.01'))).toBe(false);
      expect(() => wallet.debit(brl('100.01'), 'tx-1', later)).toThrow(InsufficientFundsError);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(NOW);
    });

    it('rejects money in another currency', () => {
      const { wallet } = openWallet('100.00');
      const usd = Money.from({ amount: '10.00', currency: 'USD' });

      expect(() => wallet.credit(usd, 'tx-1', later)).toThrow(CurrencyMismatchError);
      expect(() => wallet.debit(usd, 'tx-1', later)).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
    });

    it('rejects zero movements, so the version only moves when the balance does', () => {
      const { wallet } = openWallet('100.00');

      expect(() => wallet.credit(brl('0'), 'tx-1', later)).toThrow(InvalidWalletOperationError);
      expect(wallet.canDebit(brl('10.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it('cannot be opened with a negative balance', () => {
      expect(() =>
        Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl('1.00').negate(), at: NOW }),
      ).toThrow(InvalidWalletOperationError);
    });
  });

  it('rehydrates persisted state and keeps counting versions from there', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const entry = wallet.credit(brl('1.00'), 'tx-1', later);

    expect(entry.walletVersion).toBe(18);
    expect(wallet.balance.toJSON().amount).toBe('43.00');
  });
});
