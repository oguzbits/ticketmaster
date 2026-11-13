import { OutboxService } from '@app/api/outbox';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OUTBOX_RELAY_BATCH_SIZE, OutboxRelayJob } from './outbox-relay.job.js';

async function jobWith(relay: OutboxService['relay']): Promise<OutboxRelayJob> {
  const moduleRef = await Test.createTestingModule({
    providers: [OutboxRelayJob, { provide: OutboxService, useValue: { relay } }],
  }).compile();
  return moduleRef.get(OutboxRelayJob);
}

describe('OutboxRelayJob', () => {
  afterEach(() => vi.restoreAllMocks());

  it('relays one batch of the configured size per run', async () => {
    const sizes: number[] = [];
    const job = await jobWith(async (size) => {
      sizes.push(size);
      return { sent: 0, failed: 0 };
    });

    await job.run();

    expect(sizes).toEqual([OUTBOX_RELAY_BATCH_SIZE]);
  });

  it('logs a failing run and resolves, so the next tick still runs', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const job = await jobWith(async () => {
      throw new Error('postgres down');
    });

    await expect(job.run()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('outbox relay failed'));
  });

  it('warns when sends failed, without the message text of the error', async () => {
    const warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const job = await jobWith(async () => ({ sent: 3, failed: 2 }));

    await job.run();

    expect(warned).toHaveBeenCalledWith(expect.stringContaining('2 failed'));
  });

  it('skips a tick while the previous run is still going and runs again after it', async () => {
    let calls = 0;
    let finish: () => void = () => undefined;
    const job = await jobWith(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { sent: 0, failed: 0 };
    });

    const first = job.run();
    await job.run();
    expect(calls).toBe(1);
    finish();
    await first;
    const third = job.run();
    expect(calls).toBe(2);
    finish();
    await third;
  });
});
