import { Migration } from '@mikro-orm/migrations';

export class Migration20261102124400_initial_schema extends Migration {

  override name = 'Migration20261102124400_initial_schema';

  override up(): void | Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(20, 2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,

        constraint wallets_player_currency_key unique (player_id, currency),
        -- target for the ledger's (wallet_id, currency) foreign key
        constraint wallets_id_currency_key unique (id, currency)
      )`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) not null,
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        resulting_balance numeric(20, 2) check (resulting_balance >= 0),
        resulting_balance_currency text,
        reference_attempts integer not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,

        constraint wager_transactions_provider_external_key unique (provider_id, external_transaction_id),
        constraint wager_transactions_provider_idempotency_key unique (provider_id, idempotency_key),
        -- target for the ledger's (transaction_id, wallet_id) foreign key
        constraint wager_transactions_id_wallet_key unique (id, wallet_id),

        constraint wager_transactions_amount_check
          check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_transactions_opening_check
          check ((kind = 'OPENING') = (provider_id = 'internal')),
        constraint wager_transactions_reference_check
          check (case
                   when kind in ('REFUND', 'ROLLBACK') then reference_external_transaction_id is not null
                   when kind in ('BET', 'OPENING') then reference_external_transaction_id is null
                   else true
                 end),
        constraint wager_transactions_self_reference_check
          check (reference_transaction_id <> id),
        constraint wager_transactions_processed_reversal_check
          check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null),
        constraint wager_transactions_failure_code_check
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_check
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        constraint wager_transactions_outcome_balance_check
          check ((status in ('PROCESSED', 'REJECTED')) = (resulting_balance is not null)
                 and (resulting_balance is null) = (resulting_balance_currency is null)),
        constraint wager_transactions_pending_reference_check
          check (status <> 'PENDING_REFERENCE' or next_reference_attempt_at is not null)
      )`);

    // A transaction can be reverted (REFUND or ROLLBACK) at most once.
    this.addSql(`
      create unique index wager_transactions_single_reversal_idx
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')`);

    // What the pending-reference worker scans.
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'`);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        wallet_version integer not null check (wallet_version >= 1),
        transaction_id uuid not null,
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) not null check (amount > 0),
        currency text not null,
        balance_before numeric(20, 2) not null check (balance_before >= 0),
        balance_after numeric(20, 2) not null check (balance_after >= 0),
        created_at timestamptz not null,

        -- the entry is in the wallet's currency and belongs to the transaction's wallet
        constraint wallet_ledger_entries_wallet_fkey
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fkey
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),

        -- at most one entry per transaction and wallet
        constraint wallet_ledger_entries_transaction_wallet_key unique (transaction_id, wallet_id),
        -- one entry per wallet version: two writers on the same version collide here
        constraint wallet_ledger_entries_wallet_version_key unique (wallet_id, wallet_version),

        constraint wallet_ledger_entries_balanced_check
          check (balance_after = case direction
                                   when 'CREDIT' then balance_before + amount
                                   else balance_before - amount
                                 end)
      )`);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at timestamptz not null,
        processed_at timestamptz,

        primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz,

        constraint outbox_messages_schedule_check check (published_at is not null or next_attempt_at is not null)
      )`);

    // What the outbox relay scans: only unpublished rows are indexed.
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at)
        where published_at is null`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table outbox_messages`);
    this.addSql(`drop table inbox_messages`);
    this.addSql(`drop table wallet_ledger_entries`);
    this.addSql(`drop table wager_transactions`);
    this.addSql(`drop table wallets`);
  }

}
