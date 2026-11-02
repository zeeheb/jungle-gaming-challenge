import { Money } from '../../src/domain/shared/money';
import { computePayloadHash } from '../../src/domain/wagering/payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../src/domain/wagering/wager-transaction';
import { Wallet, type OpenedWallet } from '../../src/domain/wallet/wallet';

export const NOW = new Date('2026-07-29T15:00:00.000Z');

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';
export const CORRELATION_ID = 'corr-1';

export function openWallet(initialBalance = '100.00', at = NOW): OpenedWallet {
  return Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: brl(initialBalance), at, correlationId: CORRELATION_ID });
}

let sequence = 0;

type WagerOverrides = Partial<Omit<CreateWagerTransactionProps, 'idempotencyKey' | 'payloadHash'>>;

/** A valid BET of 10.00 BRL on wallet-1 unless told otherwise. Hash and key are derived like the API does. */
export function wager(overrides: WagerOverrides = {}): WagerTransaction {
  sequence += 1;
  const props = {
    id: `tx-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequence}`,
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    createdAt: NOW,
    correlationId: CORRELATION_ID,
    ...overrides,
  };
  return WagerTransaction.create({
    ...props,
    idempotencyKey: `${props.providerId}:${props.externalTransactionId}`,
    payloadHash: computePayloadHash(props),
  });
}
