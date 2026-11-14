import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import type { Env } from '../../../config/env.js';
import { ticketObjectKey, type TicketStore } from '../domain/ticket.js';

/** A put or a get that takes longer fails: the queue delivers the message again. */
const S3_REQUEST_TIMEOUT_MS = 10_000;
const S3_CONNECTION_TIMEOUT_MS = 3000;
const PDF_CONTENT_TYPE = 'application/pdf';

type AwsEnv = Pick<
  Env,
  'AWS_ENDPOINT_URL' | 'AWS_REGION' | 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY'
>;

/** Endpoint and credentials come from the config module only; the SDK reads no environment itself. */
export function createS3Client(
  env: AwsEnv,
  requestTimeoutMs: number = S3_REQUEST_TIMEOUT_MS
): S3Client {
  return new S3Client({
    // One attempt: the queue is the retry, so a down bucket cannot hold a handler past its timeout.
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: requestTimeoutMs,
      throwOnRequestTimeout: true,
    },
    // Unset means real AWS. The emulator needs path-style addressing (`host/bucket/key`).
    ...(env.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: env.AWS_ENDPOINT_URL, forcePathStyle: true }),
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

/** Tickets in an S3 bucket (the local emulator or AWS) under `tickets/<bookingId>.pdf`. */
export class S3TicketStore implements TicketStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string
  ) {}

  async put(bookingId: string, pdf: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: ticketObjectKey(bookingId),
        Body: pdf,
        ContentType: PDF_CONTENT_TYPE,
      })
    );
  }

  async get(bookingId: string): Promise<Uint8Array | null> {
    try {
      const { Body } = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: ticketObjectKey(bookingId) })
      );
      if (Body === undefined) throw new Error('S3 answered a ticket without a body');
      return await Body.transformToByteArray();
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }
}
