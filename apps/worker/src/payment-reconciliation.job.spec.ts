import { BookingsService } from '@app/api/bookings';
import { CLOCK } from '@app/api/clock';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { PaymentReconciliationJob } from './payment-reconciliation.job.js';

const TICK = new Date('2026-01-01T12:00:00.000Z');

describe('PaymentReconciliationJob', () => {
  it("passes the injected clock's time to reconcilePayments", async () => {
    const received: Date[] = [];
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentReconciliationJob,
        { provide: CLOCK, useValue: { now: () => TICK } },
        {
          provide: BookingsService,
          useValue: {
            reconcilePayments: async (at: Date) => {
              received.push(at);
              return { settled: 0, refunded: 0, released: 0 };
            },
          },
        },
      ],
    }).compile();

    await moduleRef.get(PaymentReconciliationJob).run();

    expect(received).toEqual([TICK]);
  });

  it('logs a failing run and resolves, so the next tick still runs', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentReconciliationJob,
        { provide: CLOCK, useValue: { now: () => TICK } },
        {
          provide: BookingsService,
          useValue: {
            reconcilePayments: async () => {
              throw new Error('database down');
            },
          },
        },
      ],
    }).compile();

    await expect(moduleRef.get(PaymentReconciliationJob).run()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('payment reconciliation failed'));
    logged.mockRestore();
  });
});
