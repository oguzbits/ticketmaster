import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BOOKING_STRATEGY, type BookingStrategy, type EventSummary } from '@app/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StrategySwitch } from './strategy-switch';

const EVENT_ID = '00000000-0000-4000-8000-0000000000e1';
const URL = `/api/events/${EVENT_ID}/strategy`;
const SUMMARY: EventSummary = {
  id: EVENT_ID,
  name: 'Gala',
  startsAt: '2099-01-01T19:00:00.000Z',
  venueName: 'Hall',
  strategy: BOOKING_STRATEGY.OPTIMISTIC,
};

function render(current: BookingStrategy = BOOKING_STRATEGY.PESSIMISTIC) {
  TestBed.configureTestingModule({
    imports: [StrategySwitch],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(StrategySwitch);
  fixture.componentRef.setInput('eventId', EVENT_ID);
  fixture.componentRef.setInput('strategy', current);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const switched = vi.fn();
  fixture.componentInstance.switched.subscribe(switched);
  TestBed.tick();
  const button = (name: RegExp) =>
    [...element.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
  const press = (name: RegExp) => {
    const target = button(name);
    if (!target) throw new Error(`No button ${String(name)}`);
    target.click();
    TestBed.tick();
  };
  const choose = (strategy: BookingStrategy) => {
    const select = element.querySelector('select');
    if (!select) throw new Error('No select');
    select.value = strategy;
    select.dispatchEvent(new Event('change'));
    TestBed.tick();
  };
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  const alertText = () => element.querySelector('[role=alert]')?.textContent ?? '';
  return { element, http, button, press, choose, answer, alertText, switched, fixture };
}

describe('StrategySwitch', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the current strategy and offers no switch to the same one', () => {
    const { element, button } = render();

    expect(element.textContent).toContain(BOOKING_STRATEGY.PESSIMISTIC);
    expect(button(/Switch strategy/)?.disabled).toBe(true);
  });

  it('asks for a confirmation and sends nothing before it', () => {
    const { element, http, press, choose } = render();
    choose(BOOKING_STRATEGY.OPTIMISTIC);

    press(/Switch strategy/);

    http.expectNone(URL);
    expect(element.textContent).toContain('Switch from PESSIMISTIC to OPTIMISTIC?');
    expect(element.textContent).toContain('existing bookings keep');
  });

  it('sends nothing when the confirmation is cancelled', () => {
    const { element, http, press, choose, button } = render();
    choose(BOOKING_STRATEGY.OPTIMISTIC);
    press(/Switch strategy/);

    press(/Cancel/);

    http.expectNone(URL);
    expect(element.textContent).not.toContain('Switch from');
    expect(button(/Switch strategy/)).toBeDefined();
  });

  it('patches the strategy once for a double confirm and reports the new one', async () => {
    const { element, http, press, choose, answer, switched, button } = render();
    choose(BOOKING_STRATEGY.OPTIMISTIC);
    press(/Switch strategy/);

    button(/Confirm/)?.click();
    button(/Confirm/)?.click();
    TestBed.tick();

    expect(button(/Switching/)?.disabled).toBe(true);
    expect(button(/Cancel/)?.disabled).toBe(true);
    const request = http.expectOne(URL);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ strategy: BOOKING_STRATEGY.OPTIMISTIC });
    await answer(() => request.flush(SUMMARY));

    expect(switched).toHaveBeenCalledWith(BOOKING_STRATEGY.OPTIMISTIC);
    expect(element.querySelector('[role=status]')?.textContent).toContain(
      BOOKING_STRATEGY.OPTIMISTIC
    );
    expect(element.textContent).not.toContain('Switch from');
  });

  it.each([
    [404, /Not allowed for this event/],
    [429, /Too many requests/],
    [400, /rejected/],
    [500, /could not be switched/],
  ])('explains a %s answer and lets the admin try again', async (status, message) => {
    const { http, press, choose, answer, alertText, switched, element } = render();
    choose(BOOKING_STRATEGY.OPTIMISTIC);
    press(/Switch strategy/);

    press(/Confirm/);
    await answer(() => http.expectOne(URL).flush(null, { status, statusText: 'Error' }));

    expect(alertText()).toMatch(message);
    expect(switched).not.toHaveBeenCalled();
    expect(element.textContent).toContain('Switch from PESSIMISTIC to OPTIMISTIC?');

    press(/Try again/);
    await answer(() => http.expectOne(URL).flush(SUMMARY));
    expect(switched).toHaveBeenCalledWith(BOOKING_STRATEGY.OPTIMISTIC);
  });
});
