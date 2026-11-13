import { QUEUE_NAME } from '@app/shared';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { createSqsClient, SqsMessageQueue } from './adapters/sqs-message-queue.js';
import { MESSAGE_QUEUE } from './domain/message-queue.js';
import { OutboxService } from './outbox.service.js';

const SQS_CLIENT = Symbol('SQS_CLIENT');

@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: (env: Env): SQSClient => createSqsClient(env),
      inject: [APP_CONFIG],
    },
    {
      // Resolves the queue by name: a missing queue fails the start of the process.
      provide: MESSAGE_QUEUE,
      useFactory: (client: SQSClient) => SqsMessageQueue.connect(client, QUEUE_NAME.BOOKING_EVENTS),
      inject: [SQS_CLIENT],
    },
    OutboxService,
  ],
  exports: [OutboxService, MESSAGE_QUEUE],
})
export class OutboxModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
