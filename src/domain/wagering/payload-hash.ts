import { createHash } from 'node:crypto';
import { canonicalJson } from '../shared/canonical-json';
import type { Money } from '../shared/money';
import type { WagerTransactionKind } from './wager-transaction';

/** Business fields of a submission. Transport data (Idempotency-Key header, messageId, timestamps) is not part of it. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * SHA-256 (hex) of the canonical JSON of the business fields. Fields are
 * picked explicitly so that adding a property somewhere else can never change
 * the hash of existing transactions. Money goes in already normalized
 * ("25.5" and "25.50" hash the same).
 */
export function computePayloadHash(payload: WagerPayload): string {
  const fields = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money,
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(fields)).digest('hex');
}
