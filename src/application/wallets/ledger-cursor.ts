import { InvalidRequestError } from '../errors';

/**
 * Opaque to clients: base64url of the last version they have seen, bound to
 * the wallet so that a cursor cannot be replayed against another one. The
 * wallet version is a stable key: unique per wallet and never reassigned, and
 * new entries only ever get higher versions, so later pages never shift.
 */
export function encodeLedgerCursor(walletId: string, lastVersion: number): string {
  return Buffer.from(JSON.stringify({ w: walletId, v: lastVersion })).toString('base64url');
}

export function decodeLedgerCursor(walletId: string, cursor: string): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidRequestError('cursor is not valid');
  }
  const { w, v } = (decoded ?? {}) as { w?: unknown; v?: unknown };
  if (w !== walletId || typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new InvalidRequestError('cursor is not valid for this wallet');
  }
  return v;
}
