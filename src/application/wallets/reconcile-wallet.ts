import { WalletReconciliation } from '../../domain/wallet/wallet-reconciliation';
import { WalletNotFoundError } from '../errors';
import { isUuid } from '../input';
import { NO_TELEMETRY, type Telemetry } from '../telemetry';
import type { UnitOfWork } from '../unit-of-work';

/**
 * POST /wallets/:id/reconciliation. Rebuilds the balance from the ledger and
 * compares it with the stored one. A divergence is reported (response, log and
 * metric, through Telemetry) and never corrected silently.
 */
export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly telemetry: Telemetry = NO_TELEMETRY,
  ) {}

  async execute(walletId: string): Promise<WalletReconciliation> {
    if (!isUuid(walletId)) {
      throw new WalletNotFoundError(walletId);
    }
    const reconciliation = await this.unitOfWork.run(async ({ wallets, ledger }) => {
      // Locked so that no writer commits between reading the balance and
      // summing the ledger: under READ COMMITTED each statement sees the latest
      // commits, and a bet landing in between would look like a divergence.
      const wallet = await wallets.findByIdForUpdate(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }
      const totals = await ledger.totals(walletId, wallet.currency);
      return WalletReconciliation.of({
        walletId,
        storedBalance: wallet.balance,
        credits: totals.credits,
        debits: totals.debits,
        checkedEntries: totals.entries,
      });
    });

    this.telemetry.walletReconciled(reconciliation);
    return reconciliation;
  }
}
