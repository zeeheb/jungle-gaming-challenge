import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';

/** Looks the URL of a queue up once and caches it. A failed lookup is tried again on the next call. */
export class QueueUrl {
  private url: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    readonly queueName: string,
  ) {}

  get(): Promise<string> {
    this.url ??= this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName })).then(
      ({ QueueUrl: url }) => {
        if (!url) {
          throw new Error(`Queue ${this.queueName} has no URL`);
        }
        return url;
      },
      (error: unknown) => {
        this.url = undefined;
        throw error;
      },
    );
    return this.url;
  }
}
