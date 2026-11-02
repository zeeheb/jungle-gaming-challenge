import { describe, expect, it } from 'bun:test';
import { InvalidRequestError } from '../../src/application/errors';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../src/application/wallets/ledger-cursor';

describe('ledger cursor', () => {
  it('round-trips the last version seen, as an opaque URL-safe string', () => {
    const cursor = encodeLedgerCursor('wallet-1', 42);

    expect(cursor).toMatch(/^[\w-]+$/);
    expect(decodeLedgerCursor('wallet-1', cursor)).toBe(42);
  });

  it('only works for the wallet it was issued for', () => {
    expect(() => decodeLedgerCursor('wallet-2', encodeLedgerCursor('wallet-1', 42))).toThrow(InvalidRequestError);
  });

  it.each(['', 'garbage', Buffer.from('{"w":"wallet-1","v":-1}').toString('base64url'), Buffer.from('[]').toString('base64url')])(
    'rejects %p',
    (cursor) => {
      expect(() => decodeLedgerCursor('wallet-1', cursor)).toThrow(InvalidRequestError);
    },
  );
});
