import { defineEntity, p, type InferEntity } from '@mikro-orm/postgresql';

// Persistence records: one per table, shaped like the rows. The domain classes
// are never handed to the ORM (their constructors are private and their state
// is encapsulated); the repositories translate between the two with
// `rehydrate`. Money is two columns, an exact NUMERIC read as a string plus
// the currency, and only becomes a Money in the mapper.
//
// The schema itself is owned by the hand-written migrations. These definitions
// only describe it to the ORM, and the many-to-one relations are declared so
// the Unit of Work inserts parents before children (the FKs are not deferred).

const amount = () => p.decimal('string').precision(20).scale(2);

export const WalletRecordSchema = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.text(),
    currency: p.text(),
    balance: amount(),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WalletRecord = InferEntity<typeof WalletRecordSchema>;

export const WagerTransactionRecordSchema = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.text(),
    wallet: p.manyToOne(WalletRecordSchema),
    playerId: p.text(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.text(),
    amount: amount(),
    currency: p.text(),
    referenceExternalTransactionId: p.text().nullable(),
    // the referenced row is always committed before, so a plain column is enough
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    resultingBalance: amount().nullable(),
    resultingBalanceCurrency: p.text().nullable(),
    referenceAttempts: p.integer(),
    nextReferenceAttemptAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
    correlationId: p.text().nullable(),
  },
});
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecordSchema>;

export const LedgerEntryRecordSchema = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    wallet: p.manyToOne(WalletRecordSchema),
    walletVersion: p.integer(),
    transaction: p.manyToOne(WagerTransactionRecordSchema),
    direction: p.text(),
    amount: amount(),
    currency: p.text(),
    balanceBefore: amount(),
    balanceAfter: amount(),
    createdAt: p.datetime(),
  },
});
export type LedgerEntryRecord = InferEntity<typeof LedgerEntryRecordSchema>;

export const InboxMessageRecordSchema = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.text(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type InboxMessageRecord = InferEntity<typeof InboxMessageRecordSchema>;

export const OutboxMessageRecordSchema = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.text(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
  },
});
export type OutboxMessageRecord = InferEntity<typeof OutboxMessageRecordSchema>;

export const entities = [
  WalletRecordSchema,
  WagerTransactionRecordSchema,
  LedgerEntryRecordSchema,
  InboxMessageRecordSchema,
  OutboxMessageRecordSchema,
];
