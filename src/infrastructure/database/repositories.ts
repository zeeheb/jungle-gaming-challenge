import { LockMode, type EntityManager } from '@mikro-orm/postgresql';
import type {
  InboxRepository,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/unit-of-work';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/shared/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import {
  InboxMessageRecordSchema,
  LedgerEntryRecordSchema,
  OutboxMessageRecordSchema,
  WagerTransactionRecordSchema,
  WalletRecordSchema,
  type OutboxMessageRecord,
  type WagerTransactionRecord,
  type WalletRecord,
} from './entities';

/** All repositories of one unit of work share its EntityManager, hence its identity map and transaction. */
export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

const toMoney = (amount: string, currency: string): Money => Money.from({ amount, currency });
const amountOf = (money: Money): string => money.toJSON().amount;

class MikroOrmWalletRepository implements WalletRepository {
  // Which managed record backs each Wallet handed out, so that update() edits
  // that record and the Unit of Work flushes a plain UPDATE of what changed.
  private readonly records = new WeakMap<Wallet, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    return this.track(await this.em.findOne(WalletRecordSchema, { id }));
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    // SELECT ... FOR UPDATE: a row lock on this wallet only, held until commit
    return this.track(await this.em.findOne(WalletRecordSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE }));
  }

  add(wallet: Wallet): void {
    const record = this.em.create(WalletRecordSchema, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      createdAt: wallet.createdAt,
      ...mutableWalletFields(wallet),
    });
    this.records.set(wallet, record);
  }

  update(wallet: Wallet): void {
    const record = this.records.get(wallet);
    if (!record) {
      throw new Error(`Wallet ${wallet.id} was not loaded by this unit of work`);
    }
    Object.assign(record, mutableWalletFields(wallet));
  }

  private track(record: WalletRecord | null): Wallet | undefined {
    if (!record) {
      return undefined;
    }
    const wallet = Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: toMoney(record.balance, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    this.records.set(wallet, record);
    return wallet;
  }
}

function mutableWalletFields(wallet: Wallet) {
  return { balance: amountOf(wallet.balance), version: wallet.version, updatedAt: wallet.updatedAt };
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  // same bookkeeping as the wallets: update() edits the record behind a
  // transaction this unit of work loaded
  private readonly records = new WeakMap<WagerTransaction, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecordSchema, { id }));
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecordSchema, { providerId, idempotencyKey }));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.track(await this.em.findOne(WagerTransactionRecordSchema, { providerId, externalTransactionId }));
  }

  async findDueForReferenceRetry(now: Date, limit: number): Promise<WagerTransaction[]> {
    // served by the partial index wager_transactions_pending_reference_idx
    const records = await this.em.find(
      WagerTransactionRecordSchema,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: 'asc', id: 'asc' }, limit },
    );
    return records.map((record) => this.track(record)!);
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const reversals = await this.em.count(WagerTransactionRecordSchema, {
      referenceTransactionId: transactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return reversals > 0;
  }

  add(transaction: WagerTransaction): void {
    const record = this.em.create(WagerTransactionRecordSchema, {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      wallet: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: amountOf(transaction.money),
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      createdAt: transaction.createdAt,
      correlationId: transaction.correlationId ?? null,
      ...mutableTransactionFields(transaction),
    });
    this.records.set(transaction, record);
  }

  update(transaction: WagerTransaction): void {
    const record = this.records.get(transaction);
    if (!record) {
      throw new Error(`Transaction ${transaction.id} was not loaded by this unit of work`);
    }
    Object.assign(record, mutableTransactionFields(transaction));
  }

  private track(record: WagerTransactionRecord | null): WagerTransaction | undefined {
    if (!record) {
      return undefined;
    }
    const transaction = toTransaction(record);
    this.records.set(transaction, record);
    return transaction;
  }
}

/** What a transaction's transitions change. The database trigger rejects changes to anything else. */
function mutableTransactionFields(transaction: WagerTransaction) {
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    resultingBalance: transaction.resultingBalance ? amountOf(transaction.resultingBalance) : null,
    resultingBalanceCurrency: transaction.resultingBalance?.currency ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
    processedAt: transaction.processedAt ?? null,
  };
}

// Status, kind and failure code are trusted as stored: CHECK constraints keep them valid.
function toTransaction(record: WagerTransactionRecord): WagerTransaction {
  const { resultingBalance, resultingBalanceCurrency } = record;
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.wallet.id,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: toMoney(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    correlationId: record.correlationId ?? undefined,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: record.processedAt ?? undefined,
    resultingBalance:
      resultingBalance != null && resultingBalanceCurrency != null
        ? toMoney(resultingBalance, resultingBalanceCurrency)
        : undefined,
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
  });
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  add(entry: WalletLedgerEntry): void {
    // Given only the transaction's id, the ORM would register a reference for it
    // and later take the new transaction for an existing row (no INSERT).
    if (!this.em.getUnitOfWork().getById(WagerTransactionRecordSchema, entry.transactionId)) {
      throw new Error(`Add or load transaction ${entry.transactionId} before its ledger entry`);
    }
    this.em.create(LedgerEntryRecordSchema, {
      id: entry.id,
      wallet: entry.walletId,
      walletVersion: entry.walletVersion,
      transaction: entry.transactionId,
      direction: entry.direction,
      amount: amountOf(entry.money),
      currency: entry.money.currency,
      balanceBefore: amountOf(entry.balanceBefore),
      balanceAfter: amountOf(entry.balanceAfter),
      createdAt: entry.createdAt,
    });
  }

  async listByWallet(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    // served by UNIQUE (wallet_id, wallet_version): an index range scan, however long the ledger
    const records = await this.em.find(
      LedgerEntryRecordSchema,
      { wallet: walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit },
    );
    return records.map((record) =>
      WalletLedgerEntry.rehydrate({
        id: record.id,
        walletId: record.wallet.id,
        walletVersion: record.walletVersion,
        transactionId: record.transaction.id,
        direction: record.direction as LedgerDirection,
        money: toMoney(record.amount, record.currency),
        balanceBefore: toMoney(record.balanceBefore, record.currency),
        balanceAfter: toMoney(record.balanceAfter, record.currency),
        createdAt: record.createdAt,
      }),
    );
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    // Credits and debits apart, so every value stays a non-negative amount;
    // a ledger that does not add up still produces a meaningful difference.
    const [row] = await this.em.execute<{ credits: string; debits: string; entries: number }[]>(
      `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0) as credits,
              coalesce(sum(amount) filter (where direction = 'DEBIT'), 0) as debits,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    return {
      credits: toMoney(String(row?.credits ?? '0'), currency),
      debits: toMoney(String(row?.debits ?? '0'), currency),
      entries: row?.entries ?? 0,
    };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageRecordSchema, { consumerName, messageId });
    if (!record) {
      return undefined;
    }
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  }

  add(message: InboxMessage): void {
    this.em.create(InboxMessageRecordSchema, {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  // same bookkeeping as the wallets: claimed messages are updated through their records
  private readonly records = new WeakMap<OutboxMessage, OutboxMessageRecord>();

  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.create(OutboxMessageRecordSchema, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      ...mutableOutboxFields(message),
    });
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // FOR UPDATE SKIP LOCKED: concurrent relays split the pending rows between
    // them instead of queueing on the same ones
    const records = await this.em.find(
      OutboxMessageRecordSchema,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { occurredAt: 'asc', id: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map((record) => {
      const message = OutboxMessage.rehydrate({
        id: record.id,
        aggregateId: record.aggregateId,
        eventType: record.eventType,
        payload: record.payload,
        occurredAt: record.occurredAt,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt ?? undefined,
        publishedAt: record.publishedAt ?? undefined,
      });
      this.records.set(message, record);
      return message;
    });
  }

  update(message: OutboxMessage): void {
    const record = this.records.get(message);
    if (!record) {
      throw new Error(`Outbox message ${message.id} was not claimed by this unit of work`);
    }
    Object.assign(record, mutableOutboxFields(message));
  }
}

function mutableOutboxFields(message: OutboxMessage) {
  return {
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  };
}
