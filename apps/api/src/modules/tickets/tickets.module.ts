import { BUCKET_NAME } from '@app/shared';
import type { S3Client } from '@aws-sdk/client-s3';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DemoModule, KEYCLOAK_ADMIN } from '../demo/index.js';
import { createS3Client, S3TicketStore } from './adapters/s3-ticket-store.js';
import { createSmtpMailSender } from './adapters/smtp-mail-sender.js';
import { MAIL_SENDER, TICKET_STORE, USER_DIRECTORY } from './domain/ticket.js';

const S3_CLIENT = Symbol('S3_CLIENT');

/** The ports of the ticket and its mail with their adapters: S3, SMTP and the Keycloak directory. */
@Module({
  imports: [DemoModule],
  providers: [
    {
      provide: S3_CLIENT,
      useFactory: (env: Env): S3Client => createS3Client(env),
      inject: [APP_CONFIG],
    },
    {
      provide: TICKET_STORE,
      useFactory: (client: S3Client) => new S3TicketStore(client, BUCKET_NAME.TICKETS),
      inject: [S3_CLIENT],
    },
    {
      provide: MAIL_SENDER,
      useFactory: (env: Env) => createSmtpMailSender(env.SMTP_URL, env.MAIL_FROM),
      inject: [APP_CONFIG],
    },
    // The admin client of the demo module already holds the Keycloak token and the timeout.
    { provide: USER_DIRECTORY, useExisting: KEYCLOAK_ADMIN },
  ],
  exports: [TICKET_STORE, MAIL_SENDER, USER_DIRECTORY],
})
export class TicketsModule implements OnApplicationShutdown {
  constructor(@Inject(S3_CLIENT) private readonly client: S3Client) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
