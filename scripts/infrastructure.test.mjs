import { describe, expect, it } from 'vitest';

import { applyInfrastructure } from './infrastructure.mjs';

const DECLARED = {
  queues: [
    { name: 'dlq', messageRetentionSeconds: 345600 },
    {
      name: 'work',
      visibilityTimeoutSeconds: 120,
      messageRetentionSeconds: 345600,
      redrive: { deadLetterQueue: 'dlq', maxReceiveCount: 5 },
    },
  ],
  buckets: ['files'],
  emailIdentities: ['tickets@example.test'],
};
const MUTATIONS = new Set([
  'CreateQueueCommand',
  'SetQueueAttributesCommand',
  'CreateBucketCommand',
  'CreateEmailIdentityCommand',
]);

/** In-memory SQS, S3 and SESv2 that answer like the emulator: unknown resources are errors. */
function fakeAws() {
  const queues = new Map();
  const buckets = new Set();
  const identities = new Set();
  const sent = [];
  const fail = (name) => Object.assign(new Error(name), { name });
  const queueOf = (url) => queues.get(url.split('/').pop());
  const sqs = {
    send(command) {
      const kind = command.constructor.name;
      const input = command.input;
      sent.push(kind);
      if (kind === 'GetQueueUrlCommand') {
        if (!queues.has(input.QueueName)) throw fail('QueueDoesNotExist');
        return { QueueUrl: `http://fake/${input.QueueName}` };
      }
      if (kind === 'CreateQueueCommand') {
        queues.set(input.QueueName, {
          QueueArn: `arn:fake:${input.QueueName}`,
          ...input.Attributes,
        });
        return { QueueUrl: `http://fake/${input.QueueName}` };
      }
      if (kind === 'GetQueueAttributesCommand')
        return { Attributes: { ...queueOf(input.QueueUrl) } };
      if (kind === 'SetQueueAttributesCommand') {
        Object.assign(queueOf(input.QueueUrl), input.Attributes);
        return {};
      }
      throw new Error(`unexpected ${kind}`);
    },
  };
  const s3 = {
    send(command) {
      const kind = command.constructor.name;
      sent.push(kind);
      if (kind === 'HeadBucketCommand') {
        if (!buckets.has(command.input.Bucket)) throw fail('NotFound');
        return {};
      }
      if (kind === 'CreateBucketCommand') {
        buckets.add(command.input.Bucket);
        return {};
      }
      throw new Error(`unexpected ${kind}`);
    },
  };
  const ses = {
    send(command) {
      const kind = command.constructor.name;
      sent.push(kind);
      if (kind === 'GetEmailIdentityCommand') {
        if (!identities.has(command.input.EmailIdentity)) throw fail('NotFoundException');
        return { VerifiedForSendingStatus: true };
      }
      if (kind === 'CreateEmailIdentityCommand') {
        identities.add(command.input.EmailIdentity);
        return { VerifiedForSendingStatus: true };
      }
      throw new Error(`unexpected ${kind}`);
    },
  };
  return { sqs, s3, ses, queues, identities, sent };
}

describe('applyInfrastructure', () => {
  it('creates the queues with the redrive policy to the dead-letter queue, the bucket and the SES identity', async () => {
    const aws = fakeAws();

    const changes = await applyInfrastructure(DECLARED, aws);

    expect(changes).toEqual([
      'created queue dlq',
      'created queue work',
      'created bucket files',
      'created email identity tickets@example.test',
    ]);
    expect(JSON.parse(aws.queues.get('work').RedrivePolicy)).toEqual({
      deadLetterTargetArn: 'arn:fake:dlq',
      maxReceiveCount: 5,
    });
    expect(aws.queues.get('work').VisibilityTimeout).toBe('120');
    expect(aws.queues.get('work').MessageRetentionPeriod).toBe('345600');
    expect(aws.queues.get('dlq').MessageRetentionPeriod).toBe('345600');
    expect(aws.identities.has('tickets@example.test')).toBe(true);
  });

  it('changes nothing when applied twice', async () => {
    const aws = fakeAws();
    await applyInfrastructure(DECLARED, aws);
    aws.sent.length = 0;

    expect(await applyInfrastructure(DECLARED, aws)).toEqual([]);
    expect(aws.sent.filter((kind) => MUTATIONS.has(kind))).toEqual([]);
  });

  it('recreates a missing queue', async () => {
    const aws = fakeAws();
    await applyInfrastructure(DECLARED, aws);
    aws.queues.delete('work');

    expect(await applyInfrastructure(DECLARED, aws)).toEqual(['created queue work']);
    expect(aws.queues.has('work')).toBe(true);
  });

  it('sets a drifted queue attribute back', async () => {
    const aws = fakeAws();
    await applyInfrastructure(DECLARED, aws);
    aws.queues.get('work').RedrivePolicy = JSON.stringify({
      deadLetterTargetArn: 'arn:fake:dlq',
      maxReceiveCount: 3,
    });
    aws.queues.get('work').VisibilityTimeout = '30';
    aws.queues.get('dlq').MessageRetentionPeriod = '60';

    expect(await applyInfrastructure(DECLARED, aws)).toEqual([
      'updated queue dlq',
      'updated queue work',
    ]);
    expect(JSON.parse(aws.queues.get('work').RedrivePolicy).maxReceiveCount).toBe(5);
    expect(aws.queues.get('work').VisibilityTimeout).toBe('120');
    expect(aws.queues.get('dlq').MessageRetentionPeriod).toBe('345600');
  });

  it('does not swallow an unexpected error when looking up a queue', async () => {
    const aws = fakeAws();
    const send = aws.sqs.send;
    aws.sqs.send = (command) => {
      if (command.constructor.name === 'GetQueueUrlCommand') {
        throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      }
      return send(command);
    };

    await expect(applyInfrastructure(DECLARED, aws)).rejects.toThrow('denied');
    expect(aws.queues.size).toBe(0);
  });

  it('does not create a bucket when the lookup fails for another reason than NotFound', async () => {
    const aws = fakeAws();
    const send = aws.s3.send;
    aws.s3.send = (command) => {
      if (command.constructor.name === 'HeadBucketCommand') {
        throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      }
      return send(command);
    };

    await expect(applyInfrastructure(DECLARED, aws)).rejects.toThrow('denied');
    expect(aws.sent).not.toContain('CreateBucketCommand');
  });

  it('does not create an SES identity when the lookup fails for another reason than NotFoundException', async () => {
    const aws = fakeAws();
    const send = aws.ses.send;
    aws.ses.send = (command) => {
      if (command.constructor.name === 'GetEmailIdentityCommand') {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      }
      return send(command);
    };

    await expect(applyInfrastructure(DECLARED, aws)).rejects.toThrow('denied');
    expect(aws.sent).not.toContain('CreateEmailIdentityCommand');
  });
});
