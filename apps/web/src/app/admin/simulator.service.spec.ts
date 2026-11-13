import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  BOOKING_STRATEGY,
  SIMULATION_STATUS,
  type SimulationProgress,
  type SimulationRun,
} from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeEventSource } from '../../testing/fake-event-source';
import { EVENT_SOURCE, SimulatorService } from './simulator.service';

const RUN_ID = '00000000-0000-4000-8000-0000000000b1';
const METRICS = {
  attempts: 10,
  holds: 4,
  conflicts: 6,
  constraintViolations: 0,
  retries: 2,
  buyersDone: 5,
  p50Ms: 3,
  p95Ms: 9,
  doubleBookings: null,
};
const RUN: SimulationRun = {
  id: RUN_ID,
  eventId: '00000000-0000-4000-8000-0000000000e1',
  strategy: BOOKING_STRATEGY.NAIVE,
  buyers: 10,
  seats: 4,
  status: SIMULATION_STATUS.QUEUED,
  metrics: null,
  startedAt: '2027-01-01T00:00:00.000Z',
  finishedAt: null,
};
const RUNNING: SimulationProgress = { status: SIMULATION_STATUS.RUNNING, metrics: METRICS };
const FINISHED: SimulationProgress = {
  status: SIMULATION_STATUS.FINISHED,
  metrics: { ...METRICS, buyersDone: 10, doubleBookings: 0 },
};

describe('SimulatorService', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: EVENT_SOURCE, useValue: FakeEventSource },
      ],
    });
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('starts a run with the request and returns the validated run', () => {
    const http = TestBed.inject(HttpTestingController);
    let result: SimulationRun | null = null;
    TestBed.inject(SimulatorService)
      .start({ buyers: 10, seats: 4, strategy: BOOKING_STRATEGY.NAIVE })
      .subscribe((run) => (result = run));

    const request = http.expectOne('/api/simulations');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      buyers: 10,
      seats: 4,
      strategy: BOOKING_STRATEGY.NAIVE,
    });
    request.flush(RUN);

    expect(result).toEqual(RUN);
  });

  it('reads the finished runs and rejects an answer off the contract', () => {
    const http = TestBed.inject(HttpTestingController);
    const service = TestBed.inject(SimulatorService);
    const results: unknown[] = [];
    let failure: Error | null = null;
    service.list().subscribe((runs) => results.push(runs));
    http.expectOne('/api/simulations').flush([RUN]);
    service.list().subscribe({ error: (error: Error) => (failure = error) });
    http.expectOne('/api/simulations').flush([{ ...RUN, buyers: -1 }]);

    expect(results).toEqual([[RUN]]);
    expect(failure).not.toBeNull();
  });

  it('emits the progress of a run and completes with the final message', () => {
    const messages: SimulationProgress[] = [];
    let completed = false;
    TestBed.inject(SimulatorService)
      .progress(RUN_ID)
      .subscribe({ next: (m) => messages.push(m), complete: () => (completed = true) });
    const [source] = FakeEventSource.instances;
    if (!source) throw new Error('no connection opened');

    expect(source.url).toBe(`/api/simulations/${RUN_ID}/stream`);
    source.send(RUNNING);
    expect(completed).toBe(false);
    source.send(FINISHED);

    expect(messages).toEqual([RUNNING, FINISHED]);
    expect(completed).toBe(true);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('closes the connection when the subscriber leaves', () => {
    const subscription = TestBed.inject(SimulatorService).progress(RUN_ID).subscribe();
    subscription.unsubscribe();

    expect(FakeEventSource.instances[0]?.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('errors on a payload off the contract and closes', () => {
    let failure: Error | null = null;
    TestBed.inject(SimulatorService)
      .progress(RUN_ID)
      .subscribe({ error: (error: Error) => (failure = error) });
    const [source] = FakeEventSource.instances;
    source?.send({ status: SIMULATION_STATUS.RUNNING });

    expect(failure).not.toBeNull();
    expect(source?.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('errors when the browser gave up on the connection but not while it reconnects', () => {
    let failure: Error | null = null;
    TestBed.inject(SimulatorService)
      .progress(RUN_ID)
      .subscribe({ error: (error: Error) => (failure = error) });
    const [source] = FakeEventSource.instances;

    source?.onerror?.(); // readyState 0: the browser reconnects on its own
    expect(failure).toBeNull();
    source?.close();
    source?.onerror?.();
    expect(failure).not.toBeNull();
  });
});
