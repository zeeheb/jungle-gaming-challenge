import type { EventContext } from '../../domain/events/wagering-events';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { newId } from '../../domain/shared/id';
import type { Money } from '../../domain/shared/money';
import { Wallet } from '../../domain/wallet/wallet';
import { moneyField, objectInput, requiredText } from '../input';
import type { UnitOfWork } from '../unit-of-work';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export function parseOpenWalletRequest(body: unknown): Pick<OpenWalletCommand, 'playerId' | 'initialBalance'> {
  const input = objectInput(body);
  return { playerId: requiredText(input, 'playerId'), initialBalance: moneyField(input, 'initialBalance') };
}

export class OpenWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Wallet, OPENING transaction, its CREDIT entry and the events are written
   * in one database transaction. A second wallet for the same player and
   * currency fails with WalletAlreadyExistsError (the unique constraint decides,
   * so two concurrent requests cannot both succeed).
   */
  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const at = new Date();
    const { wallet, opening } = Wallet.open({
      id: newId(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      at,
      correlationId: command.correlationId,
    });

    await this.unitOfWork.run(async ({ wallets, transactions, ledger, outbox }) => {
      wallets.add(wallet);
      if (opening) {
        // The opening credit is a transaction like any other, so it is announced like any other.
        const context: EventContext = { correlationId: command.correlationId, occurredAt: at };
        transactions.add(opening.transaction);
        ledger.add(opening.entry);
        outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening.transaction, context)));
        outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, opening.entry, context)));
      }
    });
    return wallet;
  }
}
