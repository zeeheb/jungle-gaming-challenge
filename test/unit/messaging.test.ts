import { describe, expect, it } from 'bun:test';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/domain/events/wagering-events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OUTBOX_RETRY, OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { NOW, brl, openWallet, wager } from '../support/builders';

const ctx = { correlationId: 'corr-1', causationId: 'msg-1', occurredAt: NOW };

describe('integration events', () => {
  it('serialize to a versioned envelope with plain JSON data', () => {
    const { wallet } = openWallet('100.00');
    const bet = wager({ money: brl('25.00') });
    const entry = wallet.debit(bet.money, bet.id, NOW);
    bet.markProcessed(undefined, wallet.balance, NOW);

    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    const json = JSON.parse(JSON.stringify(event));

    expect(json).toEqual({
      eventId: event.eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: bet.id,
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('get a fresh id per event', () => {
    const bet = wager();
    bet.markProcessed(undefined, brl('90.00'), NOW);

    const first = WagerTransactionProcessed.from(bet, ctx);
    const second = WagerTransactionProcessed.from(bet, ctx);

    expect(first.eventId).not.toBe(second.eventId);
    expect(first.toJSON().data).toMatchObject({ transactionId: bet.id, balance: { amount: '90.00', currency: 'BRL' } });
  });

  it('omit causationId when there is none', () => {
    const bet = wager();
    bet.reject(FailureCode.InsufficientFunds, brl('5.00'), NOW);

    const json = WagerTransactionRejected.from(bet, { correlationId: 'c', occurredAt: NOW }).toJSON();

    expect('causationId' in json).toBe(false);
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  it('refuse to describe an outcome that did not happen', () => {
    expect(() => WagerTransactionProcessed.from(wager(), ctx)).toThrow();
    expect(() => WagerTransactionRejected.from(wager(), ctx)).toThrow();
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const bet = wager();
    bet.markProcessed(undefined, brl('90.00'), NOW);
    return WagerTransactionProcessed.from(bet, ctx);
  };

  it('reuses the event id and stores the serialized envelope', () => {
    const source = event();
    const message = OutboxMessage.enqueue(source);

    expect(message.id).toBe(source.eventId);
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.payload).toEqual(source.toJSON());
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  it('backs off between failed publications, up to a ceiling', () => {
    const message = OutboxMessage.enqueue(event());
    const delays: number[] = [];

    for (let i = 0; i < 10; i++) {
      message.scheduleRetry(NOW);
      delays.push(message.nextAttemptAt!.getTime() - NOW.getTime());
    }

    expect(message.attempts).toBe(10);
    expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(Math.max(...delays)).toBe(OUTBOX_RETRY.maxDelayMs);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(message.nextAttemptAt!)).toBe(true);
  });

  it('stops being due once published, and cannot be published twice', () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(NOW);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
    expect(() => message.markPublished(NOW)).toThrow();
    expect(() => message.scheduleRetry(NOW)).toThrow();
  });
});

describe('InboxMessage', () => {
  it('is processed once', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-transactions',
      payloadHash: 'abc',
      receivedAt: NOW,
    });

    expect(message.isProcessed()).toBe(false);
    message.markProcessed(NOW);
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(NOW)).toThrow();
  });
});
