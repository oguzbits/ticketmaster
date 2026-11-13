import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  BOOKING_STRATEGY,
  ROLE,
  type Role,
  SIMULATION_LIMITS,
  SIMULATION_STATUS,
  type SimulationMetrics,
  type SimulationRun,
} from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeEventSource } from '../../testing/fake-event-source';
import { tokensFor } from '../../testing/tokens';
import { routes } from '../app.routes';
import { SessionStore } from '../auth/session.store';
import { EVENT_SOURCE } from './simulator.service';
import { SimulatorPage } from './simulator-page';

const RUNS_URL = '/api/simulations';
const RUN_ID = '00000000-0000-4000-8000-0000000000b1';
const METRICS: SimulationMetrics = {
  attempts: 40,
  holds: 12,
  conflicts: 28,
  constraintViolations: 0,
  retries: 5,
  buyersDone: 25,
  p50Ms: 3.4,
  p95Ms: 9.2,
  doubleBookings: null,
};
const QUEUED: SimulationRun = {
  id: RUN_ID,
  eventId: '00000000-0000-4000-8000-0000000000e1',
  strategy: BOOKING_STRATEGY.PESSIMISTIC,
  buyers: 100,
  seats: 20,
  status: SIMULATION_STATUS.QUEUED,
  metrics: null,
  startedAt: '2027-01-01T00:00:00.000Z',
  finishedAt: null,
};
const FINISHED_METRICS: SimulationMetrics = { ...METRICS, buyersDone: 100, doubleBookings: 0 };
const FINISHED: SimulationRun = {
  ...QUEUED,
  status: SIMULATION_STATUS.FINISHED,
  metrics: FINISHED_METRICS,
  finishedAt: '2027-01-01T00:00:05.000Z',
};

function render() {
  TestBed.configureTestingModule({
    imports: [SimulatorPage],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: EVENT_SOURCE, useValue: FakeEventSource },
    ],
  });
  const fixture = TestBed.createComponent(SimulatorPage);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    TestBed.tick();
    await fixture.whenStable();
  };
  const field = (id: string) => {
    const input = element.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    if (!input) throw new Error(`${id} missing`);
    return input;
  };
  const set = (id: string, value: string) => {
    const input = field(id);
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  };
  const startButton = () => {
    const button = element.querySelector<HTMLButtonElement>('button[type=submit]');
    if (!button) throw new Error('start button missing');
    return button;
  };
  const submit = () => startButton().click();
  /** Loads the list (empty unless given) and returns the page ready for input. */
  const ready = async (runs: SimulationRun[] = []) => {
    TestBed.tick();
    http.expectOne(RUNS_URL).flush(runs);
    await settle();
  };
  return { element, http, settle, field, set, submit, startButton, ready };
}

describe('SimulatorPage', () => {
  beforeEach(() => (FakeEventSource.instances = []));
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('starts with the default values and sends the chosen ones once, even on a double click', async () => {
    const { element, http, settle, set, submit, ready } = render();
    await ready();
    expect(element.querySelector<HTMLInputElement>('#sim-buyers')?.value).toBe(
      String(SIMULATION_LIMITS.BUYERS_DEFAULT)
    );
    expect(element.querySelector<HTMLInputElement>('#sim-seats')?.value).toBe(
      String(SIMULATION_LIMITS.SEATS_DEFAULT)
    );

    set('sim-buyers', '100');
    set('sim-seats', '20');
    set('sim-strategy', BOOKING_STRATEGY.OPTIMISTIC);
    submit();
    submit();
    await settle();

    const request = http.expectOne(RUNS_URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      buyers: 100,
      seats: 20,
      strategy: BOOKING_STRATEGY.OPTIMISTIC,
    });
    request.flush(QUEUED);
  });

  it('marks values beyond the limits as invalid and sends nothing', async () => {
    const { http, settle, set, submit, ready, field } = render();
    await ready();

    set('sim-buyers', String(SIMULATION_LIMITS.BUYERS_MAX + 1));
    set('sim-seats', '0');
    submit();
    await settle();

    expect(field('sim-buyers').validity.rangeOverflow).toBe(true);
    expect(field('sim-seats').validity.rangeUnderflow).toBe(true);
    expect(http.match(RUNS_URL)).toHaveLength(0);
  });

  it('shows the busy message on 429 and allows another start', async () => {
    const { element, http, settle, submit, startButton, ready } = render();
    await ready();

    submit();
    await settle();
    http.expectOne(RUNS_URL).flush(null, { status: 429, statusText: 'Too Many Requests' });
    await settle();

    expect(element.querySelector('[role=alert]')?.textContent).toContain('Two runs are active');
    expect(startButton().disabled).toBe(false);
  });

  it('shows a generic message for another failed start', async () => {
    const { element, http, settle, submit, ready } = render();
    await ready();

    submit();
    await settle();
    http.expectOne(RUNS_URL).flush(null, { status: 500, statusText: 'Server Error' });
    await settle();

    expect(element.querySelector('[role=alert]')?.textContent).toContain('could not be started');
  });

  it('updates the counters from the stream and keeps start disabled while the run is active', async () => {
    const { element, http, settle, submit, startButton, ready } = render();
    await ready();
    submit();
    await settle();
    http.expectOne(RUNS_URL).flush(QUEUED);
    await settle();

    const [source] = FakeEventSource.instances;
    expect(source?.url).toBe(`${RUNS_URL}/${RUN_ID}/stream`);
    source?.send({ status: SIMULATION_STATUS.RUNNING, metrics: METRICS });
    await settle();

    const text = element.textContent ?? '';
    expect(text).toContain(SIMULATION_STATUS.RUNNING);
    expect(text).toContain('28');
    expect(text).toContain('9 ms');
    expect(element.querySelector('progress')?.value).toBe(25);
    expect(startButton().disabled).toBe(true);
  });

  it('closes the stream on FINISHED, reads the list again and shows the run in the table', async () => {
    const { element, http, settle, submit, startButton, ready } = render();
    await ready();
    submit();
    await settle();
    http.expectOne(RUNS_URL).flush(QUEUED);
    await settle();

    FakeEventSource.instances[0]?.send({
      status: SIMULATION_STATUS.FINISHED,
      metrics: FINISHED_METRICS,
    });
    TestBed.tick();
    http.expectOne(RUNS_URL).flush([FINISHED]);
    await settle();

    expect(FakeEventSource.instances[0]?.readyState).toBe(FakeEventSource.CLOSED);
    expect(startButton().disabled).toBe(false);
    const row = element.querySelector('tbody tr');
    expect(row?.textContent).toContain(BOOKING_STRATEGY.PESSIMISTIC);
    expect(row?.textContent).toContain('12');
  });

  it('says in words that a run has double bookings', async () => {
    const { element, http, settle, submit, ready } = render();
    await ready();
    submit();
    await settle();
    http.expectOne(RUNS_URL).flush({ ...QUEUED, strategy: BOOKING_STRATEGY.NAIVE });
    await settle();

    FakeEventSource.instances[0]?.send({
      status: SIMULATION_STATUS.FINISHED,
      metrics: { ...FINISHED_METRICS, doubleBookings: 7 },
    });
    TestBed.tick();
    http.expectOne(RUNS_URL).flush([]);
    await settle();

    expect(element.textContent).toContain('7 seats sold twice');
  });

  it('shows a failed run with its own message and enables start again', async () => {
    const { element, http, settle, submit, startButton, ready } = render();
    await ready();
    submit();
    await settle();
    http.expectOne(RUNS_URL).flush(QUEUED);
    await settle();

    FakeEventSource.instances[0]?.send({ status: SIMULATION_STATUS.FAILED, metrics: METRICS });
    await settle();

    expect(element.querySelector('[role=alert]')?.textContent).toContain('The run failed');
    expect(startButton().disabled).toBe(false);
  });

  it('offers to reconnect when the live view breaks off', async () => {
    const { element, http, settle, submit, ready } = render();
    await ready();
    submit();
    await settle();
    http.expectOne(RUNS_URL).flush(QUEUED);
    await settle();

    FakeEventSource.instances[0]?.close();
    FakeEventSource.instances[0]?.onerror?.();
    await settle();
    expect(element.querySelector('[role=alert]')?.textContent).toContain('live view');
    const reconnect = [...element.querySelectorAll('button')].find((b) =>
      /Reconnect/.test(b.textContent)
    );
    reconnect?.click();
    await settle();

    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('says so when no run has finished yet', async () => {
    const { element, ready } = render();
    await ready();

    expect(element.textContent).toContain('No finished runs yet');
    expect(element.querySelector('table')).toBeNull();
  });

  it('shows loading while the list is read', () => {
    const { element } = render();
    TestBed.tick();

    expect(element.querySelector('[role=status]')?.textContent).toContain('Loading');
    TestBed.inject(HttpTestingController).expectOne(RUNS_URL);
  });

  it('offers a retry when the list fails and loads again on click', async () => {
    const { element, http, settle } = render();
    TestBed.tick();
    http.expectOne(RUNS_URL).flush(null, { status: 503, statusText: 'Service Unavailable' });
    await settle();
    expect(element.querySelector('[role=alert]')?.textContent).toContain('could not be loaded');

    [...element.querySelectorAll('button')].find((b) => /Try again/.test(b.textContent))?.click();
    TestBed.tick();
    http.expectOne(RUNS_URL).flush([FINISHED]);
    await settle();

    expect(element.querySelector('tbody tr')).not.toBeNull();
  });
});

describe('simulator route', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  async function visit(role: Role | null) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    });
    if (role) TestBed.inject(SessionStore).set(tokensFor(role));
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/admin/simulator');
    return router.url;
  }

  it('lets an admin open the screen', async () => {
    expect(await visit(ROLE.ADMIN)).toBe('/admin/simulator');
    TestBed.tick();
    TestBed.inject(HttpTestingController).match(RUNS_URL);
  });

  it.each([ROLE.CUSTOMER, ROLE.ORGANIZER])('sends %s to the event list', async (role) => {
    expect(await visit(role)).toBe('/events');
  });

  it('sends a visitor without a session to the start page', async () => {
    expect(await visit(null)).toBe('/');
  });
});
