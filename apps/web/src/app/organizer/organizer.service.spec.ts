import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  BOOKING_STRATEGY,
  type CreateEventRequest,
  type EventSummary,
  type OrganizerEvent,
  type Venue,
} from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OrganizerService } from './organizer.service';

const VENUE: Venue = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Hall', seatCount: 40 };
const REQUEST: CreateEventRequest = {
  venueId: VENUE.id,
  name: 'Gala',
  startsAt: '2099-01-01T19:00:00.000Z',
  strategy: BOOKING_STRATEGY.PESSIMISTIC,
};
const SUMMARY: EventSummary = {
  id: '00000000-0000-4000-8000-0000000000e1',
  name: 'Gala',
  startsAt: REQUEST.startsAt,
  venueName: 'Hall',
  strategy: REQUEST.strategy,
};
const OWN: OrganizerEvent = {
  ...SUMMARY,
  seatCount: 40,
  soldCount: 10,
  heldCount: 2,
  utilization: 0.25,
};

describe('OrganizerService', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
  );
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('reads the venues and the own events', () => {
    const http = TestBed.inject(HttpTestingController);
    const service = TestBed.inject(OrganizerService);
    const results: unknown[] = [];
    service.venues().subscribe((venues) => results.push(venues));
    service.events().subscribe((events) => results.push(events));

    http.expectOne('/api/venues').flush([VENUE]);
    http.expectOne('/api/organizer/events').flush([OWN]);

    expect(results).toEqual([[VENUE], [OWN]]);
  });

  it('create posts the request and returns the validated summary', () => {
    const http = TestBed.inject(HttpTestingController);
    let result: EventSummary | null = null;
    TestBed.inject(OrganizerService)
      .create(REQUEST)
      .subscribe((summary) => (result = summary));

    const request = http.expectOne('/api/events');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(REQUEST);
    request.flush(SUMMARY);

    expect(result).toEqual(SUMMARY);
  });

  it('rejects an answer that does not match the contract', () => {
    const http = TestBed.inject(HttpTestingController);
    let failure: Error | null = null;
    TestBed.inject(OrganizerService)
      .events()
      .subscribe({ error: (error: Error) => (failure = error) });

    http.expectOne('/api/organizer/events').flush([{ ...OWN, utilization: 7 }]);

    expect(failure).not.toBeNull();
  });
});
