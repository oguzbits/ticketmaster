import { BookingsService } from '@app/api/bookings';
import { DemoService } from '@app/api/demo';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { SimulationConsumer } from './simulation.consumer.js';
import { WorkerModule } from './worker.module.js';

describe('WorkerModule', () => {
  // Both jobs publish seat changes to Redis (hold expiry, demo cleanup): the wiring has to be
  // complete in this process too, not only in the API.
  it('resolves every provider, the seat change publisher included', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();

    expect(moduleRef.get(BookingsService, { strict: false })).toBeInstanceOf(BookingsService);
    expect(moduleRef.get(DemoService, { strict: false })).toBeInstanceOf(DemoService);
    expect(moduleRef.get(SimulationConsumer)).toBeInstanceOf(SimulationConsumer);
    await moduleRef.close();
  });
});
