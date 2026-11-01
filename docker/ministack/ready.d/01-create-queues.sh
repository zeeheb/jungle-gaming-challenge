#!/bin/sh
set -eu

SQS="aws --endpoint-url=http://localhost:4566 sqs"

$SQS create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true >/dev/null

DLQ_URL=$($SQS get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$($SQS get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# After 5 failed receives the broker moves the message to the DLQ on its own.
$SQS create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }" >/dev/null

# Outgoing integration events published by the outbox relay.
$SQS create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true >/dev/null

echo "sqs queues ready"
