import { BUCKET_NAME } from '@app/shared';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import { APP_CONFIG } from '../../config/config.module.js';
import { type Env, MAIL_PROVIDER } from '../../config/env.js';
import { DemoModule, KEYCLOAK_ADMIN } from '../demo/index.js';
import { createS3Client, S3TicketStore } from './adapters/s3-ticket-store.js';
import { createSesClient, createSesMailSender } from './adapters/ses-mail-sender.js';
import { createSmtpMailSender } from './adapters/smtp-mail-sender.js';
import { MAIL_SENDER, TICKET_STORE, USER_DIRECTORY } from './domain/ticket.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsService } from './tickets.service.js';

const S3_CLIENT = Symbol('S3_CLIENT');
const SES_CLIENT = Symbol('SES_CLIENT');

/** The ports of the ticket and its mail with their adapters: S3, SES/SMTP and the Keycloak directory. */
@Module({
  imports: [DemoModule],
  controllers: [TicketsController],
  providers: [
    TicketsService,
    {
      provide: S3_CLIENT,
      useFactory: (env: Env): S3Client => createS3Client(env),
      inject: [APP_CONFIG],
    },
    {
      provide: SES_CLIENT,
      useFactory: (env: Env): SESv2Client | null =>
        env.MAIL_PROVIDER === MAIL_PROVIDER.SES ? createSesClient(env) : null,
      inject: [APP_CONFIG],
    },
    {
      provide: TICKET_STORE,
      useFactory: (client: S3Client, env: Env) =>
        new S3TicketStore(client, BUCKET_NAME.TICKETS, env.S3_PRESIGN_BASE_URL),
      inject: [S3_CLIENT, APP_CONFIG],
    },
    {
      provide: MAIL_SENDER,
      useFactory: (env: Env, ses: SESv2Client | null) => {
        if (ses !== null) return createSesMailSender(ses, env.MAIL_FROM);
        if (env.SMTP_URL === undefined) {
          throw new Error('SMTP_URL is required when MAIL_PROVIDER=smtp');
        }
        return createSmtpMailSender(env.SMTP_URL, env.MAIL_FROM);
      },
      inject: [APP_CONFIG, SES_CLIENT],
    },
    // The admin client of the demo module already holds the Keycloak token and the timeout.
    { provide: USER_DIRECTORY, useExisting: KEYCLOAK_ADMIN },
  ],
  exports: [TicketsService, TICKET_STORE, MAIL_SENDER, USER_DIRECTORY],
})
export class TicketsModule implements OnApplicationShutdown {
  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    @Inject(SES_CLIENT) private readonly sesClient: SESv2Client | null
  ) {}

  onApplicationShutdown(): void {
    this.client.destroy();
    this.sesClient?.destroy();
  }
}
