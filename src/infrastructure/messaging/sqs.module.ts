import { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { env } from '../../config/env';

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: () =>
        new SQSClient({
          endpoint: env.sqs.endpoint,
          region: env.sqs.region,
          credentials: { accessKeyId: env.sqs.accessKeyId, secretAccessKey: env.sqs.secretAccessKey },
        }),
    },
  ],
  exports: [SQSClient],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
