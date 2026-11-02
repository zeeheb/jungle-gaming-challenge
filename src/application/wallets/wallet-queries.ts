import type { Wallet } from '../../domain/wallet/wallet';
import { WalletNotFoundError } from '../errors';
import { isUuid } from '../input';
import type { UnitOfWork } from '../unit-of-work';

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
}
