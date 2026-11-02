import { Migration } from '@mikro-orm/migrations';

/**
 * Keeps the correlation id of the request that created a transaction, so the
 * events of a decision taken later (by the pending-reference worker) stay in
 * the same trace as the request.
 *
 * Nullable on purpose: rows written before this migration have no correlation
 * id to recover, and a backfill would have to bypass the trigger that freezes
 * terminal transactions.
 */
export class Migration20261102181958_transaction_correlation_id extends Migration {

  override name = 'Migration20261102181958_transaction_correlation_id';

  override up(): void | Promise<void> {
    this.addSql(`alter table wager_transactions add column correlation_id text`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table wager_transactions drop column correlation_id`);
  }

}
