import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUCKET_NAME,
  INFRASTRUCTURE,
  QUEUE_NAME,
  QUEUE_POLICY,
  SES_IDENTITY,
} from '../packages/shared/dist/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MESSAGING_DIR = path.join(ROOT, 'infra/modules/messaging');

function readTf(file) {
  return fs.readFileSync(path.join(MESSAGING_DIR, file), 'utf8');
}

function tfDefault(content, variableName) {
  const blockMatch = new RegExp(`variable\\s+"${variableName}"\\s*\\{([\\s\\S]*?)\\n\\}`).exec(
    content
  );
  if (!blockMatch) return undefined;
  const stringMatch = /default\s*=\s*"([^"]+)"/.exec(blockMatch[1]);
  if (stringMatch) return stringMatch[1];
  const numberMatch = /default\s*=\s*(\d+)/.exec(blockMatch[1]);
  return numberMatch ? Number(numberMatch[1]) : undefined;
}

describe('OpenTofu messaging module parity with packages/shared', () => {
  const variablesTf = readTf('variables.tf');
  const mainTf = readTf('main.tf');

  it('declares the exact queue names, bucket, and SES identity from INFRASTRUCTURE', () => {
    expect(tfDefault(variablesTf, 'booking_events_queue_name')).toBe(QUEUE_NAME.BOOKING_EVENTS);
    expect(tfDefault(variablesTf, 'booking_events_dlq_name')).toBe(QUEUE_NAME.BOOKING_EVENTS_DLQ);
    expect(tfDefault(variablesTf, 'tickets_bucket_name')).toBe(BUCKET_NAME.TICKETS);
    expect(tfDefault(variablesTf, 'ses_sender_email')).toBe(SES_IDENTITY.TICKETS_FROM);

    expect(INFRASTRUCTURE.queues.map((q) => q.name)).toEqual([
      QUEUE_NAME.BOOKING_EVENTS_DLQ,
      QUEUE_NAME.BOOKING_EVENTS,
    ]);
    expect(INFRASTRUCTURE.buckets).toEqual([BUCKET_NAME.TICKETS]);
    expect(INFRASTRUCTURE.emailIdentities).toEqual([SES_IDENTITY.TICKETS_FROM]);
  });

  it('declares the exact queue policy defaults (visibility timeout, retention, maxReceiveCount)', () => {
    expect(tfDefault(variablesTf, 'visibility_timeout_seconds')).toBe(
      QUEUE_POLICY.VISIBILITY_TIMEOUT_SECONDS
    );
    expect(tfDefault(variablesTf, 'message_retention_seconds')).toBe(
      QUEUE_POLICY.MESSAGE_RETENTION_SECONDS
    );
    expect(tfDefault(variablesTf, 'max_receive_count')).toBe(QUEUE_POLICY.MAX_RECEIVE_COUNT);
  });

  it('wires redrive policy and visibility timeout in main.tf', () => {
    expect(mainTf).toContain('deadLetterTargetArn = aws_sqs_queue.booking_events_dlq.arn');
    expect(mainTf).toContain('maxReceiveCount     = var.max_receive_count');
    expect(mainTf).toContain('visibility_timeout_seconds = var.visibility_timeout_seconds');
  });
});
