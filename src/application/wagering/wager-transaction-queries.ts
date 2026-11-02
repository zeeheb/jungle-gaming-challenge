import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionNotFoundError } from '../errors';
import { isUuid } from '../input';
import type { UnitOfWork } from '../unit-of-work';

export class WagerTransactionQueries {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async getById(transactionId: string): Promise<WagerTransaction> {
    const transaction = isUuid(transactionId)
      ? await this.unitOfWork.run(({ transactions }) => transactions.findById(transactionId))
      : undefined;
    if (!transaction) {
      throw new WagerTransactionNotFoundError(`Transaction ${transactionId} not found`);
    }
    return transaction;
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.run(({ transactions }) =>
      transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!transaction) {
      throw new WagerTransactionNotFoundError(
        `Transaction ${externalTransactionId} of provider ${providerId} not found`,
      );
    }
    return transaction;
  }
}
