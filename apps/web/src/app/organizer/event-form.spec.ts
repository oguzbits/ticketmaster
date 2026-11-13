import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BOOKING_STRATEGY, type EventSummary, type Venue } from '@app/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventForm } from './event-form';

const VENUES_URL = '/api/venues';
const EVENTS_URL = '/api/events';
const HALL: Venue = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Hall', seatCount: 40 };
const ARENA: Venue = { id: '00000000-0000-4000-8000-0000000000a2', name: 'Arena', seatCount: 900 };
const FUTURE = '2099-01-01T19:00';
const SUMMARY: EventSummary = {
  id: '00000000-0000-4000-8000-0000000000e1',
  name: 'Gala',
  startsAt: new Date(FUTURE).toISOString(),
  venueName: 'Arena',
  strategy: BOOKING_STRATEGY.OPTIMISTIC,
};

function render() {
  TestBed.configureTestingModule({
    imports: [EventForm],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(EventForm);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const created = vi.fn();
  fixture.componentInstance.created.subscribe(created);
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  TestBed.tick();
  const field = (label: string) => {
    const text = [...element.querySelectorAll('label')].find(
      (l) => l.textContent?.trim() === label
    );
    const control =
      text && element.querySelector<HTMLInputElement | HTMLSelectElement>(`#${text.htmlFor}`);
    if (!control) throw new Error(`No field ${label}`);
    return control;
  };
  const fill = (label: string, value: string) => {
    const control = field(label);
    control.value = value;
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input'));
  };
  const submit = () => {
    element
      .querySelector('button[type=submit]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    TestBed.tick();
  };
  const loaded = (venues: Venue[] = [HALL, ARENA]) =>
    answer(() => http.expectOne(VENUES_URL).flush(venues));
  /** A valid form: Arena, a name, a future start, the optimistic strategy. */
  const fillValid = () => {
    fill('Venue', ARENA.id);
    fill('Name', '  Gala ');
    fill('Starts at', FUTURE);
    fill('Strategy', BOOKING_STRATEGY.OPTIMISTIC);
  };
  const alertText = () => element.querySelector('[role=alert]')?.textContent ?? '';
  return { element, http, answer, field, fill, submit, loaded, fillValid, alertText, created };
}

describe('EventForm', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows loading, then the venues with their seat counts', async () => {
    const { element, loaded, field } = render();
    expect(element.querySelector('[role=status]')?.textContent).toContain('Loading');

    await loaded();

    const options = [...field('Venue').querySelectorAll('option')].map((o) =>
      o.textContent?.trim()
    );
    expect(options).toEqual(['Hall (40 seats)', 'Arena (900 seats)']);
  });

  it('says so when there are no venues and offers no form', async () => {
    const { element, loaded } = render();
    await loaded([]);

    expect(element.textContent).toContain('No venues');
    expect(element.querySelector('form')).toBeNull();
  });

  it('offers a retry when the venues fail and loads again on click', async () => {
    const { element, http, answer } = render();
    await answer(() =>
      http.expectOne(VENUES_URL).flush(null, { status: 503, statusText: 'Service Unavailable' })
    );
    expect(element.querySelector('[role=alert]')).not.toBeNull();

    element.querySelector('button')?.click();
    TestBed.tick();
    await answer(() => http.expectOne(VENUES_URL).flush([HALL]));

    expect(element.querySelector('[role=alert]')).toBeNull();
    expect(element.querySelector('form')).not.toBeNull();
  });

  it('posts the trimmed name, the start as UTC and the chosen venue and strategy', async () => {
    const { http, answer, loaded, fillValid, submit, created, element } = render();
    await loaded();
    fillValid();

    submit();
    const request = http.expectOne(EVENTS_URL);
    expect(request.request.body).toEqual({
      venueId: ARENA.id,
      name: 'Gala',
      startsAt: new Date(FUTURE).toISOString(),
      strategy: BOOKING_STRATEGY.OPTIMISTIC,
    });
    await answer(() => request.flush(SUMMARY));

    expect(created).toHaveBeenCalledWith(SUMMARY);
    expect(element.querySelector('[role=status]')?.textContent).toContain('Event created');
  });

  it('sends one request for a double submit and disables the button meanwhile', async () => {
    const { http, loaded, fillValid, element } = render();
    await loaded();
    fillValid();

    // Two submits before a render: only the guard in the component stops the second one.
    const form = element.querySelector('form');
    form?.dispatchEvent(new Event('submit'));
    form?.dispatchEvent(new Event('submit'));
    TestBed.tick();

    const button = element.querySelector<HTMLButtonElement>('button[type=submit]');
    expect(button?.disabled).toBe(true);
    http.expectOne(EVENTS_URL).flush(SUMMARY);
  });

  it('sends nothing for an empty name', async () => {
    const { http, loaded, fill, submit, alertText } = render();
    await loaded();
    fill('Name', '   ');
    fill('Starts at', FUTURE);

    submit();

    http.expectNone(EVENTS_URL);
    expect(alertText()).toContain('Enter a name');
  });

  it.each(['2000-01-01T19:00', ''])('sends nothing for the start "%s"', async (startsAt) => {
    const { http, loaded, fill, submit, alertText } = render();
    await loaded();
    fill('Name', 'Gala');
    fill('Starts at', startsAt);

    submit();

    http.expectNone(EVENTS_URL);
    expect(alertText()).toContain('future');
  });

  it.each([
    [409, /limit/],
    [429, /Too many requests/],
    [400, /rejected/],
    [404, /venue no longer exists/],
    [500, /could not be created/],
  ])('explains a %s answer and keeps the input so the user can retry', async (status, message) => {
    const { http, answer, loaded, fillValid, submit, alertText, created, field, element } =
      render();
    await loaded();
    fillValid();

    submit();
    await answer(() => http.expectOne(EVENTS_URL).flush(null, { status, statusText: 'Error' }));

    expect(alertText()).toMatch(message);
    expect(created).not.toHaveBeenCalled();
    expect(field('Name').value).toBe('  Gala ');
    expect(element.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(false);

    submit();
    http.expectOne(EVENTS_URL).flush(SUMMARY);
  });
});
