import { BookingsService } from '@app/api/bookings';
import { DemoService } from '@app/api/demo';
import { OutboxService } from '@app/api/outbox';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { OutboxRelayJob } from './outbox-relay.job.js';
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
    // The relay needs the queue adapter, which connects to the emulator at start.
    expect(moduleRef.get(OutboxService, { strict: false })).toBeInstanceOf(OutboxService);
    expect(moduleRef.get(OutboxRelayJob)).toBeInstanceOf(OutboxRelayJob);
    await moduleRef.close();
  });
});
