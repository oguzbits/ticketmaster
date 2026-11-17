import { CLOCK } from '@app/api/clock';
import { DemoService } from '@app/api/demo';
import { TICKET_STORE } from '@app/api/tickets';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { DemoCleanupJob } from './demo-cleanup.job.js';

const TICK = new Date('2026-01-01T12:00:00.000Z');

describe('DemoCleanupJob', () => {
  it('passes the injected clock time and ticket store deleter to deleteExpired', async () => {
    const received: Date[] = [];
    const deleted: string[] = [];
    const moduleRef = await Test.createTestingModule({
      providers: [
        DemoCleanupJob,
        { provide: CLOCK, useValue: { now: () => TICK } },
        {
          provide: TICKET_STORE,
          useValue: {
            delete: async (bookingId: string) => {
              deleted.push(bookingId);
            },
          },
        },
        {
          provide: DemoService,
          useValue: {
            deleteExpired: async (at: Date, deleteTicket: (bookingId: string) => Promise<void>) => {
              received.push(at);
              await deleteTicket('booking-1');
              return 1;
            },
          },
        },
      ],
    }).compile();

    await moduleRef.get(DemoCleanupJob).run();

    expect(received).toEqual([TICK]);
    expect(deleted).toEqual(['booking-1']);
  });

  it('logs a failing run and resolves, so the next tick still runs', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        DemoCleanupJob,
        { provide: CLOCK, useValue: { now: () => TICK } },
        { provide: TICKET_STORE, useValue: { delete: async () => undefined } },
        {
          provide: DemoService,
          useValue: {
            deleteExpired: async () => {
              throw new Error('keycloak down');
            },
          },
        },
      ],
    }).compile();

    await expect(moduleRef.get(DemoCleanupJob).run()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('demo cleanup failed'));
    logged.mockRestore();
  });
});
