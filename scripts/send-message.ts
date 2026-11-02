import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { parseArgs } from 'node:util';
import { env } from '../src/config/env';
import { newId } from '../src/domain/shared/id';

// Publishes WagerTransactionRequested messages to wager-transactions.fifo, the
// way a provider would. For demos and manual checks:
//
//   bun run send-message --wallet <walletId> --player <playerId> [--kind BET] [--amount 10.00]
//                        [--reference <externalId>] [--external <externalId>] [--copies 2]

const { values } = parseArgs({
  options: {
    wallet: { type: 'string' },
    player: { type: 'string' },
    kind: { type: 'string', default: 'BET' },
    amount: { type: 'string', default: '10.00' },
    currency: { type: 'string', default: 'BRL' },
    provider: { type: 'string', default: 'provider-a' },
    external: { type: 'string' },
    reference: { type: 'string' },
    round: { type: 'string', default: 'round-1' },
    // the same message (same messageId) sent several times, as a redelivery would
    copies: { type: 'string', default: '1' },
  },
});

if (!values.wallet || !values.player) {
  console.error('usage: bun run send-message --wallet <walletId> --player <playerId> [--kind BET] [--amount 10.00] ...');
  process.exit(1);
}

const externalTransactionId = values.external ?? `ext-${newId()}`;
const message = {
  messageId: `msg-${newId()}`,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: values.provider,
    externalTransactionId,
    idempotencyKey: `${values.provider}:${externalTransactionId}`,
    playerId: values.player,
    walletId: values.wallet,
    roundId: values.round,
    gameId: 'fortune-chimp',
    kind: values.kind,
    money: { amount: values.amount, currency: values.currency },
    ...(values.reference && { referenceExternalTransactionId: values.reference }),
  },
};

const sqs = new SQSClient({
  endpoint: env.sqs.endpoint,
  region: env.sqs.region,
  credentials: { accessKeyId: env.sqs.accessKeyId, secretAccessKey: env.sqs.secretAccessKey },
});
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: env.sqs.transactionsQueue }));
for (let copy = 0; copy < Number(values.copies); copy++) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: values.wallet, // FIFO order per wallet
      MessageDeduplicationId: newId(), // a new broker id per copy, so SQS does not drop them
    }),
  );
}
sqs.destroy();
console.log(JSON.stringify({ sent: Number(values.copies), messageId: message.messageId, externalTransactionId }));
