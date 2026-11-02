import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/shared/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { computePayloadHash, type WagerPayload } from '../../src/domain/wagering/payload-hash';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  REFERENCE_RETRY,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from '../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';
import { NOW, brl, wager } from '../support/builders';

const processed = (tx: WagerTransaction): WagerTransaction => {
  tx.markProcessed(undefined, brl('100.00'), NOW);
  return tx;
};

describe('WagerTransaction', () => {
  describe('create', () => {
    it('is born PENDING', () => {
      const tx = wager();
      expect(tx.status).toBe(Status.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.referenceAttempts).toBe(0);
    });

    it('does not accept OPENING from the outside', () => {
      expect(() => wager({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
    });

    it('reserves the internal provider id', () => {
      expect(() => wager({ providerId: 'internal' })).toThrow(InvalidWagerTransactionError);
    });

    it.each([Kind.Refund, Kind.Rollback])('requires a reference for %s', (kind) => {
      expect(() => wager({ kind })).toThrow(InvalidWagerTransactionError);
      expect(wager({ kind, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
    });

    it('lets WIN and LOSS point to their BET, but not BET to anything', () => {
      expect(wager({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(false);
      expect(wager({ kind: Kind.Loss, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(false);
      expect(() => wager({ kind: Kind.Bet, referenceExternalTransactionId: 'bet-1' })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('cannot reference itself', () => {
      expect(() =>
        wager({ kind: Kind.Refund, externalTransactionId: 'x', referenceExternalTransactionId: 'x' }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('requires a positive amount, except for LOSS which may be zero', () => {
      expect(() => wager({ kind: Kind.Bet, money: brl('0') })).toThrow(InvalidWagerTransactionError);
      expect(() => wager({ kind: Kind.Win, money: brl('0') })).toThrow(InvalidWagerTransactionError);
      expect(wager({ kind: Kind.Loss, money: brl('0') }).status).toBe(Status.Pending);
    });

    it('requires business identifiers', () => {
      expect(() => wager({ roundId: '' })).toThrow(InvalidWagerTransactionError);
      expect(() => wager({ playerId: '   ' })).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('terminal statuses', () => {
    const terminal: Array<[string, (tx: WagerTransaction) => void]> = [
      ['PROCESSED', (tx) => tx.markProcessed(undefined, brl('1.00'), NOW)],
      ['REJECTED', (tx) => tx.reject(FailureCode.InsufficientFunds, brl('1.00'), NOW)],
      ['FAILED', (tx) => tx.fail(FailureCode.ProcessingFailed, NOW)],
    ];

    it.each(terminal)('a %s transaction refuses any further transition', (_, toTerminal) => {
      const tx = wager({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' });
      toTerminal(tx);

      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, brl('1.00'), NOW)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds, brl('1.00'), NOW)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.ProcessingFailed, NOW)).toThrow(InvalidTransactionStateError);
    });

    it('keeps the balance observed when the outcome was decided', () => {
      const bet = processed(wager());
      expect(bet.resultingBalance?.toJSON().amount).toBe('100.00');
      expect(bet.processedAt).toEqual(NOW);
    });

    it('will not process a reversal without its reference', () => {
      const refund = wager({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
      expect(() => refund.markProcessed(undefined, brl('1.00'), NOW)).toThrow(InvalidTransactionStateError);
    });
  });

  describe('waiting for a reference', () => {
    it('backs off exponentially between lookups', () => {
      const refund = wager({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
      const delays: number[] = [];

      for (let i = 0; i < 4; i++) {
        refund.markPendingReference(NOW);
        delays.push(refund.nextReferenceAttemptAt!.getTime() - NOW.getTime());
      }

      expect(refund.status).toBe(Status.PendingReference);
      expect(refund.referenceAttempts).toBe(4);
      expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
    });

    it('runs out of attempts after the configured budget', () => {
      const refund = wager({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
      for (let i = 1; i < REFERENCE_RETRY.maxAttempts; i++) refund.markPendingReference(NOW);
      expect(refund.hasExhaustedReferenceAttempts()).toBe(false);

      refund.markPendingReference(NOW);
      expect(refund.hasExhaustedReferenceAttempts()).toBe(true);
    });

    it('cannot wait for a reference it does not have', () => {
      expect(() => wager({ kind: Kind.Bet }).markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
    });

    it('is due for a new lookup only once its scheduled time has come', () => {
      const refund = wager({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
      expect(refund.isDueForReferenceRetry(NOW)).toBe(false); // still PENDING

      refund.markPendingReference(NOW); // next lookup in 1s
      expect(refund.isDueForReferenceRetry(new Date(NOW.getTime() + 999))).toBe(false);
      expect(refund.isDueForReferenceRetry(new Date(NOW.getTime() + 1_000))).toBe(true);

      refund.reject(FailureCode.ReferenceNotFound, brl('0.00'), NOW);
      expect(refund.isDueForReferenceRetry(new Date(NOW.getTime() + 1_000))).toBe(false);
    });

    it('keeps the correlation id of the request that created it, outside the payload hash', () => {
      const a = wager({ externalTransactionId: 'same', correlationId: 'request-a' });
      const b = wager({ externalTransactionId: 'same', correlationId: 'request-b' });

      expect(a.correlationId).toBe('request-a');
      expect(a.payloadHash).toBe(b.payloadHash);
    });
  });

  describe('balance effect', () => {
    it.each([
      [Kind.Bet, LedgerDirection.Debit],
      [Kind.Win, LedgerDirection.Credit],
      [Kind.Refund, LedgerDirection.Credit],
    ])('%s moves the balance as a %s', (kind, direction) => {
      const tx = wager({ kind, ...(kind === Kind.Refund ? { referenceExternalTransactionId: 'bet-1' } : {}) });
      expect(tx.affectsBalance()).toBe(true);
      expect(tx.ledgerDirectionFor()).toBe(direction);
    });

    it('LOSS does not move the balance', () => {
      const loss = wager({ kind: Kind.Loss });
      expect(loss.affectsBalance()).toBe(false);
      expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Credit],
      [Kind.Win, LedgerDirection.Debit],
      [Kind.Refund, LedgerDirection.Debit],
    ])('ROLLBACK of a %s goes the opposite way: %s', (referenceKind, expected) => {
      const reference = wager({
        kind: referenceKind,
        ...(referenceKind === Kind.Refund ? { referenceExternalTransactionId: 'bet-0' } : {}),
      });
      const rollback = wager({ kind: Kind.Rollback, referenceExternalTransactionId: reference.externalTransactionId });

      expect(rollback.ledgerDirectionFor(reference)).toBe(expected);
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    });
  });

  describe('checkReference', () => {
    const refundOf = (bet: WagerTransaction, overrides = {}) =>
      wager({
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
        money: bet.money,
        ...overrides,
      });
    const ok = { alreadyReversed: false };

    it('accepts a processed BET of the same round, player, wallet and amount', () => {
      const bet = processed(wager());
      expect(refundOf(bet).checkReference(bet, ok)).toEqual({ result: 'valid' });
    });

    it('waits while the reference itself is still pending', () => {
      expect(refundOf(wager()).checkReference(wager(), ok)).toEqual({ result: 'not-ready' });
    });

    it('rejects a reference that was not processed', () => {
      const bet = wager();
      bet.reject(FailureCode.InsufficientFunds, brl('0'), NOW);
      expect(refundOf(bet).checkReference(bet, ok)).toEqual({
        result: 'invalid',
        code: FailureCode.ReferenceNotProcessed,
      });
    });

    it.each([
      ['round', { roundId: 'round-2' }],
      ['player', { playerId: 'player-2' }],
      ['wallet', { walletId: 'wallet-2' }],
      ['provider', { providerId: 'provider-b' }],
    ])('rejects a reference from another %s', (_, overrides) => {
      const bet = processed(wager());
      expect(refundOf(bet, overrides).checkReference(bet, ok)).toEqual({
        result: 'invalid',
        code: FailureCode.ReferenceMismatch,
      });
    });

    it('rejects a reference in another currency', () => {
      const bet = processed(wager());
      const usdRefund = refundOf(bet, { money: Money.from({ amount: '10.00', currency: 'USD' }) });
      expect(usdRefund.checkReference(bet, ok)).toEqual({ result: 'invalid', code: FailureCode.ReferenceMismatch });
    });

    it('only lets REFUND revert a BET', () => {
      const win = processed(wager({ kind: Kind.Win }));
      expect(refundOf(win).checkReference(win, ok)).toEqual({
        result: 'invalid',
        code: FailureCode.ReferenceKindNotAllowed,
      });
    });

    it('lets ROLLBACK revert BET, WIN or REFUND, but not LOSS', () => {
      for (const kind of [Kind.Bet, Kind.Win]) {
        const reference = processed(wager({ kind }));
        const rollback = wager({
          kind: Kind.Rollback,
          referenceExternalTransactionId: reference.externalTransactionId,
          money: reference.money,
        });
        expect(rollback.checkReference(reference, ok)).toEqual({ result: 'valid' });
      }

      const loss = processed(wager({ kind: Kind.Loss }));
      const rollback = wager({ kind: Kind.Rollback, referenceExternalTransactionId: loss.externalTransactionId });
      expect(rollback.checkReference(loss, ok)).toEqual({
        result: 'invalid',
        code: FailureCode.ReferenceKindNotAllowed,
      });
    });

    it('rejects partial reversals', () => {
      const bet = processed(wager({ money: brl('10.00') }));
      expect(refundOf(bet, { money: brl('5.00') }).checkReference(bet, ok)).toEqual({
        result: 'invalid',
        code: FailureCode.ReferenceAmountMismatch,
      });
    });

    it('rejects reverting the same transaction twice', () => {
      const bet = processed(wager());
      expect(refundOf(bet).checkReference(bet, { alreadyReversed: true })).toEqual({
        result: 'invalid',
        code: FailureCode.ReferenceAlreadyReversed,
      });
    });
  });

  describe('payload hash (idempotency)', () => {
    const payload: WagerPayload = {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: Kind.Bet,
      money: brl('25.00'),
    };

    it('is a stable sha-256 hex digest', () => {
      expect(computePayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
      expect(computePayloadHash(payload)).toBe(computePayloadHash({ ...payload }));
    });

    it('does not depend on key order or on how the amount was written', () => {
      const reordered = {
        money: Money.from({ currency: 'BRL', amount: '25' }),
        kind: Kind.Bet,
        gameId: 'fortune-chimp',
        roundId: 'round-987',
        walletId: 'wallet-1',
        playerId: 'player-1',
        externalTransactionId: 'transaction-123',
        providerId: 'provider-a',
      };
      expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
    });

    it('ignores anything that is not a business field', () => {
      const withNoise = { ...payload, idempotencyKey: 'whatever', messageId: 'msg-1' } as WagerPayload;
      expect(computePayloadHash(withNoise)).toBe(computePayloadHash(payload));
    });

    it.each([
      ['amount', { money: brl('25.01') }],
      ['kind', { kind: Kind.Win }],
      ['wallet', { walletId: 'wallet-2' }],
      ['reference', { referenceExternalTransactionId: 'bet-1' }],
    ])('changes when the %s changes, so the same key with that payload is a conflict', (_, change) => {
      const original = wager({ ...payload });
      const divergentHash = computePayloadHash({ ...payload, ...change });

      expect(original.matchesPayload(computePayloadHash(payload))).toBe(true);
      expect(original.matchesPayload(divergentHash)).toBe(false);
    });
  });
});
