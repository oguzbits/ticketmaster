import { BookingsService } from '@app/api/bookings';
import { DemoService } from '@app/api/demo';
import { OutboxService } from '@app/api/outbox';
import { WaitingRoomService } from '@app/api/waiting-room';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { DemoCleanupJob } from './demo-cleanup.job.js';
import { OperationalGauges } from './operational-gauges.js';
import { OutboxRelayJob } from './outbox-relay.job.js';
import { PaymentReconciliationJob } from './payment-reconciliation.job.js';
import { SimulationConsumer } from './simulation.consumer.js';
import { TicketRetentionJob } from './ticket-retention.job.js';
import { WaitingRoomAdmissionJob } from './waiting-room-admission.job.js';
import { WorkerModule } from './worker.module.js';

describe('WorkerModule', () => {
  // Both jobs publish seat changes to Redis (hold expiry, demo cleanup): the wiring has to be
  // complete in this process too, not only in the API.
  it('resolves every provider, the seat change publisher included', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();

    expect(moduleRef.get(BookingsService, { strict: false })).toBeInstanceOf(BookingsService);
    expect(moduleRef.get(DemoService, { strict: false })).toBeInstanceOf(DemoService);
    expect(moduleRef.get(DemoCleanupJob)).toBeInstanceOf(DemoCleanupJob);
    expect(moduleRef.get(SimulationConsumer)).toBeInstanceOf(SimulationConsumer);
    // The relay needs the queue adapter, which connects to the emulator at start.
    expect(moduleRef.get(OutboxService, { strict: false })).toBeInstanceOf(OutboxService);
    expect(moduleRef.get(OutboxRelayJob)).toBeInstanceOf(OutboxRelayJob);
    expect(moduleRef.get(PaymentReconciliationJob)).toBeInstanceOf(PaymentReconciliationJob);
    expect(moduleRef.get(TicketRetentionJob)).toBeInstanceOf(TicketRetentionJob);
    expect(moduleRef.get(WaitingRoomService, { strict: false })).toBeInstanceOf(WaitingRoomService);
    expect(moduleRef.get(WaitingRoomAdmissionJob)).toBeInstanceOf(WaitingRoomAdmissionJob);
    // Only the worker observes the shared state (outbox, queues, waiting rooms): the API has no such provider.
    expect(moduleRef.get(OperationalGauges)).toBeInstanceOf(OperationalGauges);
    await moduleRef.close();
  });
});
