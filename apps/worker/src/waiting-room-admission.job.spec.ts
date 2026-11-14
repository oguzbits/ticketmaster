import { WaitingRoomService } from '@app/api/waiting-room';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { WaitingRoomAdmissionJob } from './waiting-room-admission.job.js';

describe('WaitingRoomAdmissionJob', () => {
  it('calls admitDue on every run', async () => {
    let calls = 0;
    const moduleRef = await Test.createTestingModule({
      providers: [
        WaitingRoomAdmissionJob,
        {
          provide: WaitingRoomService,
          useValue: {
            admitDue: async () => {
              calls += 1;
              return 0;
            },
          },
        },
      ],
    }).compile();
    const job = moduleRef.get(WaitingRoomAdmissionJob);

    await job.run();
    await job.run();

    expect(calls).toBe(2);
  });

  it('logs a failing tick and resolves, so the next tick still runs', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        WaitingRoomAdmissionJob,
        {
          provide: WaitingRoomService,
          useValue: {
            admitDue: async () => {
              throw new Error('redis down');
            },
          },
        },
      ],
    }).compile();

    await expect(moduleRef.get(WaitingRoomAdmissionJob).run()).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('waiting room admission failed'));
    logged.mockRestore();
  });
});
