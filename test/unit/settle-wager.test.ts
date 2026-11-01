import { beforeEach, describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/shared/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { settleWager, type Settlement } from '../../src/domain/wagering/settle-wager';
import {
  REFERENCE_RETRY,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from '../../src/domain/wagering/wager-transaction';
import type { Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';
import { NOW, brl, openWallet, wager } from '../support/builders';

const context = { correlationId: 'corr-1', occurredAt: NOW };

let wallet: Wallet;
let ledger: WalletLedgerEntry[];

beforeEach(() => {
  const opened = openWallet('100.00');
  wallet = opened.wallet;
  ledger = [opened.opening!.entry];
});

function settle(transaction: WagerTransaction, reference?: WagerTransaction, referenceAlreadyReversed = false) {
  const settlement = settleWager({ wallet, transaction, reference, referenceAlreadyReversed, context });
  if (settlement.entry) ledger.push(settlement.entry);
  return settlement;
}

const eventTypes = (settlement: Settlement) => settlement.events.map((event) => event.eventType);

const processedBet = (amount = '30.00') => {
  const bet = wager({ kind: Kind.Bet, money: brl(amount) });
  settle(bet);
  return bet;
};

const reversalOf = (kind: Kind.Refund | Kind.Rollback, reference: WagerTransaction, overrides = {}) =>
  wager({ kind, referenceExternalTransactionId: reference.externalTransactionId, money: reference.money, ...overrides });

// The invariant every test must keep: the stored balance is what the ledger says.
function expectBalance(amount: string) {
  const fromLedger = ledger.reduce((sum, entry) => sum.add(entry.signedAmount()), Money.zero('BRL'));
  expect(wallet.balance.toJSON().amount).toBe(amount);
  expect(fromLedger.equals(wallet.balance)).toBe(true);
  expect(wallet.version).toBe(ledger.length);
}

describe('settleWager', () => {
  describe('BET', () => {
    it('debits the wallet and announces both the transaction and the balance change', () => {
      const bet = wager({ money: brl('25.00') });

      const settlement = settle(bet);

      expect(bet.status).toBe(Status.Processed);
      expect(bet.resultingBalance?.toJSON().amount).toBe('75.00');
      expect(settlement.entry?.direction).toBe(LedgerDirection.Debit);
      expect(eventTypes(settlement)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      expectBalance('75.00');
    });

    it('is rejected without funds, leaving balance and ledger alone', () => {
      const bet = wager({ money: brl('100.01') });

      const settlement = settle(bet);

      expect(bet.status).toBe(Status.Rejected);
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(bet.resultingBalance?.toJSON().amount).toBe('100.00');
      expect(settlement.entry).toBeUndefined();
      expect(eventTypes(settlement)).toEqual(['WagerTransactionRejected']);
      expectBalance('100.00');
    });

    it('100.00 and two bets of 80.00: exactly one goes through', () => {
      const first = wager({ money: brl('80.00') });
      const second = wager({ money: brl('80.00') });

      settle(first);
      settle(second);

      expect([first.status, second.status]).toEqual([Status.Processed, Status.Rejected]);
      expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(ledger.filter((entry) => entry.direction === LedgerDirection.Debit)).toHaveLength(1);
      expectBalance('20.00');
    });
  });

  describe('WIN', () => {
    it('credits the wallet', () => {
      const win = wager({ kind: Kind.Win, money: brl('50.00') });

      const settlement = settle(win);

      expect(win.status).toBe(Status.Processed);
      expect(settlement.entry?.direction).toBe(LedgerDirection.Credit);
      expectBalance('150.00');
    });

    it('records the BET it refers to', () => {
      const bet = processedBet();
      const win = wager({ kind: Kind.Win, referenceExternalTransactionId: bet.externalTransactionId, money: brl('60.00') });

      settle(win, bet);

      expect(win.referenceTransactionId).toBe(bet.id);
      expectBalance('130.00');
    });
  });

  describe('LOSS', () => {
    it('is processed without touching the balance, the ledger or the version', () => {
      const loss = wager({ kind: Kind.Loss, money: brl('0') });

      const settlement = settle(loss);

      expect(loss.status).toBe(Status.Processed);
      expect(settlement.entry).toBeUndefined();
      expect(eventTypes(settlement)).toEqual(['WagerTransactionProcessed']);
      expectBalance('100.00');
      expect(wallet.version).toBe(1);
    });
  });

  describe('REFUND', () => {
    it('gives the BET amount back', () => {
      const bet = processedBet('30.00');
      const refund = reversalOf(Kind.Refund, bet);

      const settlement = settle(refund, bet);

      expect(refund.status).toBe(Status.Processed);
      expect(refund.referenceTransactionId).toBe(bet.id);
      expect(settlement.entry?.direction).toBe(LedgerDirection.Credit);
      expectBalance('100.00');
    });

    it('happens only once per BET', () => {
      const bet = processedBet();
      const refund = reversalOf(Kind.Refund, bet);

      settle(refund, bet, true);

      expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expectBalance('70.00');
    });

    it('must match the BET amount', () => {
      const bet = processedBet('30.00');
      const refund = reversalOf(Kind.Refund, bet, { money: brl('10.00') });

      settle(refund, bet);

      expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
      expectBalance('70.00');
    });

    it('cannot refund a WIN', () => {
      const win = wager({ kind: Kind.Win, money: brl('10.00') });
      settle(win);
      const refund = reversalOf(Kind.Refund, win);

      settle(refund, win);

      expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });

    it('cannot refund a BET that was rejected', () => {
      const bet = wager({ money: brl('500.00') });
      settle(bet);
      const refund = reversalOf(Kind.Refund, bet);

      settle(refund, bet);

      expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
      expectBalance('100.00');
    });

    it('cannot refund a BET from another round', () => {
      const bet = processedBet();
      const refund = reversalOf(Kind.Refund, bet, { roundId: 'round-2' });

      settle(refund, bet);

      expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    });
  });

  describe('ROLLBACK', () => {
    it('of a BET credits it back', () => {
      const bet = processedBet('30.00');
      const rollback = reversalOf(Kind.Rollback, bet);

      expect(settle(rollback, bet).entry?.direction).toBe(LedgerDirection.Credit);
      expectBalance('100.00');
    });

    it('of a WIN takes the prize back', () => {
      const win = wager({ kind: Kind.Win, money: brl('50.00') });
      settle(win);
      const rollback = reversalOf(Kind.Rollback, win);

      expect(settle(rollback, win).entry?.direction).toBe(LedgerDirection.Debit);
      expectBalance('100.00');
    });

    it('of a REFUND charges the bet again', () => {
      const bet = processedBet('30.00');
      const refund = reversalOf(Kind.Refund, bet);
      settle(refund, bet);
      const rollback = reversalOf(Kind.Rollback, refund);

      expect(settle(rollback, refund).entry?.direction).toBe(LedgerDirection.Debit);
      expectBalance('70.00');
    });

    it('of a WIN already spent is rejected with its own failure code', () => {
      const win = wager({ kind: Kind.Win, money: brl('50.00') });
      settle(win);
      settle(wager({ money: brl('120.00') }));
      const rollback = reversalOf(Kind.Rollback, win);

      settle(rollback, win);

      expect(rollback.status).toBe(Status.Rejected);
      expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
      expectBalance('30.00');
    });

    it('cannot revert a BET twice, even if it was refunded before', () => {
      const bet = processedBet();
      const rollback = reversalOf(Kind.Rollback, bet);

      settle(rollback, bet, true);

      expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
      expectBalance('70.00');
    });
  });

  describe('reference that has not arrived', () => {
    it('parks the transaction as PENDING_REFERENCE and says so once', () => {
      const refund = wager({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-from-the-future' });

      const first = settle(refund);
      const retry = settle(refund);

      expect(refund.status).toBe(Status.PendingReference);
      expect(refund.referenceAttempts).toBe(2);
      expect(eventTypes(first)).toEqual(['WagerTransactionPendingReference']);
      expect(retry.events).toHaveLength(0);
      expectBalance('100.00');
    });

    it('is applied normally once the reference shows up', () => {
      const bet = wager({ externalTransactionId: 'late-bet', money: brl('30.00') });
      const rollback = wager({ kind: Kind.Rollback, referenceExternalTransactionId: 'late-bet', money: brl('30.00') });

      settle(rollback);
      settle(bet);
      settle(rollback, bet);

      expect(rollback.status).toBe(Status.Processed);
      expectBalance('100.00');
    });

    it('waits while the reference is itself waiting', () => {
      const pendingRefund = wager({ kind: Kind.Refund, referenceExternalTransactionId: 'missing' });
      settle(pendingRefund);
      const rollback = reversalOf(Kind.Rollback, pendingRefund);

      settle(rollback, pendingRefund);

      expect(rollback.status).toBe(Status.PendingReference);
    });

    it('gives up after the retry budget with REFERENCE_NOT_FOUND', () => {
      const refund = wager({ kind: Kind.Refund, referenceExternalTransactionId: 'never-coming' });

      let last: Settlement | undefined;
      for (let i = 0; i < REFERENCE_RETRY.maxAttempts; i++) last = settle(refund);

      expect(refund.status).toBe(Status.Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(eventTypes(last!)).toEqual(['WagerTransactionRejected']);
      expectBalance('100.00');
    });
  });

  describe('wallet checks', () => {
    it('rejects a currency different from the wallet', () => {
      const bet = wager({ money: Money.from({ amount: '10.00', currency: 'USD' }) });

      settle(bet);

      expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
      expectBalance('100.00');
    });

    it('rejects a player that does not own the wallet', () => {
      const bet = wager({ playerId: 'someone-else' });

      settle(bet);

      expect(bet.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    });

    it('refuses to settle a transaction against the wrong wallet', () => {
      expect(() => settle(wager({ walletId: 'wallet-2' }))).toThrow();
    });
  });

  it('keeps the balance seen at the time for replays, even after the wallet moves on', () => {
    const bet = wager({ money: brl('10.00') });
    settle(bet);
    settle(wager({ kind: Kind.Win, money: brl('500.00') }));

    expect(bet.resultingBalance?.toJSON().amount).toBe('90.00');
    expectBalance('590.00');
  });
});
