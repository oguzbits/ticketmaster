import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BOOKING_STRATEGY, type EventSummary } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WaitingRoomSettings } from './waiting-room-settings';

const EVENT_ID = '00000000-0000-4000-8000-0000000000a2';
const URL = `/api/events/${EVENT_ID}/waiting-room/settings`;

const summaryWith = (waitingRoomCapacity: number | null): EventSummary => ({
  id: EVENT_ID,
  name: 'Summer Tour',
  startsAt: '2027-06-01T18:00:00.000Z',
  venueName: 'Hall A',
  strategy: BOOKING_STRATEGY.PESSIMISTIC,
  waitingRoomCapacity,
});

@Component({
  imports: [WaitingRoomSettings],
  template: `
    <app-waiting-room-settings
      [eventId]="eventId"
      [capacity]="capacity()"
      (saved)="capacity.set($event)"
    />
  `,
})
class Host {
  readonly eventId = EVENT_ID;
  readonly capacity = signal<number | null>(null);
}

function setup(initial: number | null = null) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.capacity.set(initial);
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const input = (): HTMLInputElement => {
    const field = element.querySelector<HTMLInputElement>('#waiting-room-capacity');
    if (field === null) throw new Error('capacity input not found');
    return field;
  };
  const button = (label: string): HTMLButtonElement => {
    const match = [...element.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label
    );
    if (match === undefined) throw new Error(`button not found: ${label}`);
    return match;
  };
  const setInput = (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  return { fixture, element, http, input, button, setInput };
}

describe('WaitingRoomSettings', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('saves a valid capacity, updates the current capacity and avoids double submit', () => {
    const { fixture, element, http, input, button, setInput } = setup(null);
    expect(element.textContent).toContain('Current capacity: Off');
    expect(button('Save capacity').disabled).toBe(true);

    setInput('25');
    button('Save capacity').click();
    fixture.detectChanges();

    expect(button('Saving…').disabled).toBe(true);
    expect(input().disabled).toBe(true);
    button('Saving…').click();
    const request = http.expectOne({ method: 'PUT', url: URL });
    expect(request.request.body).toEqual({ capacity: 25 });

    request.flush(summaryWith(25));
    fixture.detectChanges();

    expect(element.textContent).toContain('Current capacity: 25');
    expect(element.textContent).toContain('Waiting room capacity is now 25.');
  });

  it('turns the waiting room off with one click and shows an error when refused', () => {
    const { fixture, element, http, button } = setup(10);

    button('Turn off').click();
    fixture.detectChanges();
    http.expectOne({ method: 'PUT', url: URL }).flush(null, { status: 404, statusText: 'No' });
    fixture.detectChanges();

    expect(element.querySelector('[role=alert]')?.textContent).toContain('Not allowed');

    button('Turn off').click();
    fixture.detectChanges();
    const request = http.expectOne({ method: 'PUT', url: URL });
    expect(request.request.body).toEqual({ capacity: null });
    request.flush(summaryWith(null));
    fixture.detectChanges();

    expect(element.textContent).toContain('Current capacity: Off');
    expect(element.textContent).toContain('Waiting room is now off.');
  });

  it('refuses an invalid number before sending a request', () => {
    const { fixture, element, button, setInput } = setup(null);

    setInput('0');
    button('Save capacity').click();
    fixture.detectChanges();

    expect(element.querySelector('[role=alert]')?.textContent).toContain('whole number between 1');
  });
});
