import { BookingsService } from '@app/api/bookings';
import { CLOCK } from '@app/api/clock';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { HoldExpiryJob } from './hold-expiry.job.js';

const TICK = new Date('2026-01-01T12:00:00.000Z');

describe('HoldExpiryJob', () => {
  it("passes the injected clock's time to expireHolds", async () => {
    const received: Date[] = [];
    const moduleRef = await Test.createTestingModule({
      providers: [
        HoldExpiryJob,
        { provide: CLOCK, useValue: { now: () => TICK } },
        {
          provide: BookingsService,
          useValue: { expireHolds: async (at: Date) => received.push(at) },
        },
      ],
    }).compile();

    await moduleRef.get(HoldExpiryJob).run();

    expect(received).toEqual([TICK]);
  });

  it('logs a failing run and resolves, so the next tick still runs', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        HoldExpiryJob,
        { provide: CLOCK, useValue: { now: () => TICK } },
        {
          provide: BookingsService,
          useValue: {
            expireHolds: async () => {
              throw new Error('keycloak down');
            },
          },
        },
      ],
    }).compile();

    await expect(moduleRef.get(HoldExpiryJob).run()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('hold expiry failed'));
    logged.mockRestore();
  });
});
