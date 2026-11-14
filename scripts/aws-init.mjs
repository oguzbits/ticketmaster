#!/usr/bin/env node

/**
 * Applies the declared infrastructure (`INFRASTRUCTURE`, packages/shared) to the AWS-compatible
 * endpoint: the local emulator by default. Safe to run again. Runs as the one-shot `aws-init`
 * Compose service (api and worker wait for it) and on the host (`pnpm aws:init`). See ADR 0006.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';

import { INFRASTRUCTURE } from '../packages/shared/dist/index.js';
import { applyInfrastructure } from './infrastructure.mjs';

const config = {
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:45660',
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
};

const changes = await applyInfrastructure(INFRASTRUCTURE, {
  sqs: new SQSClient(config),
  s3: new S3Client({ ...config, forcePathStyle: true }),
});
console.log(`aws-init: ${changes.length > 0 ? changes.join(', ') : 'nothing to change'}`);
