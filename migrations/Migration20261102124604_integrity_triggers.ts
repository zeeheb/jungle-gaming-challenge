import { Migration } from '@mikro-orm/migrations';

/**
 * Rules a CHECK constraint cannot express because they look at the previous
 * row value or at other tables:
 *
 * - the ledger is append-only, wallets and transactions are never deleted;
 * - a wallet's identity never changes and its version moves with its balance;
 * - a terminal transaction is frozen, and so are its business fields;
 * - each ledger entry continues the previous one, and at commit time every
 *   balance change has its entry and every entry is reflected in the wallet.
 *   Together these make "balance == sum of the ledger" a database invariant.
 */
export class Migration20261102124604_integrity_triggers extends Migration {

  override name = 'Migration20261102124604_integrity_triggers';

  override up(): void | Promise<void> {
    this.addSql(`
      create function reject_mutation() returns trigger language plpgsql as $$
      begin
        raise exception '% on % is not allowed', tg_op, tg_table_name
          using errcode = 'integrity_constraint_violation';
      end
      $$`);

    for (const table of ['wallet_ledger_entries', 'wallets', 'wager_transactions']) {
      const operations = table === 'wallet_ledger_entries' ? 'update or delete' : 'delete';
      this.addSql(`
        create trigger ${table}_no_${operations.replaceAll(' ', '_')}
          before ${operations} on ${table}
          for each row execute function reject_mutation()`);
      this.addSql(`
        create trigger ${table}_no_truncate
          before truncate on ${table}
          for each statement execute function reject_mutation()`);
    }

    this.addSql(`
      create function wallets_guard_update() returns trigger language plpgsql as $$
      begin
        if (new.id, new.player_id, new.currency, new.created_at)
           is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet % cannot change its identity', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallet % changed its balance without moving to version %', old.id, old.version + 1
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet % changed its version without changing its balance', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger wallets_guard_update
        before update on wallets
        for each row execute function wallets_guard_update()`);

    this.addSql(`
      create function wager_transactions_guard_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is % and cannot change', old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.status = 'PENDING' and old.status <> 'PENDING' then
          raise exception 'wager transaction % cannot go back to PENDING', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % business fields are immutable', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger wager_transactions_guard_update
        before update on wager_transactions
        for each row execute function wager_transactions_guard_update()`);

    // A wallet opened with a zero balance has no entry for version 1, so its
    // first entry is version 2. Otherwise each entry follows the previous one.
    this.addSql(`
      create function wallet_ledger_entries_check_chain() returns trigger language plpgsql as $$
      declare
        previous record;
      begin
        select wallet_version, balance_after into previous
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by wallet_version desc
         limit 1;

        if not found then
          if new.wallet_version not in (1, 2) or new.balance_before <> 0 then
            raise exception 'first ledger entry of wallet % must start from zero at version 1 or 2', new.wallet_id
              using errcode = 'integrity_constraint_violation';
          end if;
        elsif previous.wallet_version <> new.wallet_version - 1 or previous.balance_after <> new.balance_before then
          raise exception 'ledger entry % does not continue entry version % of wallet %',
            new.id, previous.wallet_version, new.wallet_id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $$`);
    this.addSql(`
      create trigger wallet_ledger_entries_check_chain
        before insert on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_check_chain()`);

    // Deferred to commit time: inside a transaction the wallet row and the
    // entry are written one after the other, in any order.
    this.addSql(`
      create function wallets_check_ledger() returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' and new.version <> 1 then
          raise exception 'wallet % must be created at version 1', new.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if (tg_op = 'INSERT' and new.balance = 0) or (tg_op = 'UPDATE' and new.version = old.version) then
          return null;
        end if;

        perform 1 from wallet_ledger_entries
         where wallet_id = new.id and wallet_version = new.version and balance_after = new.balance;
        if not found then
          raise exception 'wallet % reached version % without a matching ledger entry', new.id, new.version
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end
      $$`);
    this.addSql(`
      create constraint trigger wallets_backed_by_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_check_ledger()`);

    this.addSql(`
      create function wallet_ledger_entries_check_applied() returns trigger language plpgsql as $$
      begin
        perform 1 from wallets
         where id = new.wallet_id
           and (version > new.wallet_version or (version = new.wallet_version and balance = new.balance_after));
        if not found then
          raise exception 'ledger entry % (version %) is not reflected in wallet %', new.id, new.wallet_version, new.wallet_id
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end
      $$`);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_applied_to_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_check_applied()`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger wallet_ledger_entries_applied_to_wallet on wallet_ledger_entries`);
    this.addSql(`drop function wallet_ledger_entries_check_applied()`);
    this.addSql(`drop trigger wallets_backed_by_ledger on wallets`);
    this.addSql(`drop function wallets_check_ledger()`);
    this.addSql(`drop trigger wallet_ledger_entries_check_chain on wallet_ledger_entries`);
    this.addSql(`drop function wallet_ledger_entries_check_chain()`);
    this.addSql(`drop trigger wager_transactions_guard_update on wager_transactions`);
    this.addSql(`drop function wager_transactions_guard_update()`);
    this.addSql(`drop trigger wallets_guard_update on wallets`);
    this.addSql(`drop function wallets_guard_update()`);

    for (const table of ['wallet_ledger_entries', 'wallets', 'wager_transactions']) {
      const operations = table === 'wallet_ledger_entries' ? 'update or delete' : 'delete';
      this.addSql(`drop trigger ${table}_no_${operations.replaceAll(' ', '_')} on ${table}`);
      this.addSql(`drop trigger ${table}_no_truncate on ${table}`);
    }
    this.addSql(`drop function reject_mutation()`);
  }

}
