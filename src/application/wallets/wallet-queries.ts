import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { InvalidRequestError, WalletNotFoundError } from '../errors';
import { isUuid } from '../input';
import type { UnitOfWork } from '../unit-of-work';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

export const LEDGER_PAGE = { defaultLimit: 50, maxLimit: 200 } as const;

export interface LedgerPageRequest {
  cursor?: string | undefined;
  limit?: string | undefined;
}

export interface LedgerPage {
  walletId: string;
  entries: WalletLedgerEntry[];
  /** Null on the last page. */
  nextCursor: string | null;
}

export class WalletQueries {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** Ids are always UUIDs, so anything else simply does not exist. */
  async getById(walletId: string): Promise<Wallet> {
    const wallet = isUuid(walletId)
      ? await this.unitOfWork.run(({ wallets }) => wallets.findById(walletId))
      : undefined;
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }

  /** The wallet's statement, oldest entry first, a page at a time. */
  async getLedger(walletId: string, request: LedgerPageRequest): Promise<LedgerPage> {
    const limit = parseLimit(request.limit);
    const afterVersion = request.cursor === undefined ? 0 : decodeLedgerCursor(walletId, request.cursor);
    if (!isUuid(walletId)) {
      throw new WalletNotFoundError(walletId);
    }

    return this.unitOfWork.run(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(walletId))) {
        throw new WalletNotFoundError(walletId);
      }
      // one extra row tells whether another page exists, without a count
      const entries = await ledger.listByWallet(walletId, afterVersion, limit + 1);
      const page = entries.slice(0, limit);
      const last = page.at(-1);
      return {
        walletId,
        entries: page,
        nextCursor: entries.length > limit && last ? encodeLedgerCursor(walletId, last.walletVersion) : null,
      };
    });
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return LEDGER_PAGE.defaultLimit;
  }
  const limit = Number(raw);
  if (!/^\d+$/.test(raw) || limit < 1 || limit > LEDGER_PAGE.maxLimit) {
    throw new InvalidRequestError(`limit must be an integer from 1 to ${LEDGER_PAGE.maxLimit}`);
  }
  return limit;
}
