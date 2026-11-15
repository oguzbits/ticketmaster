import { BOOKING_STRATEGY, type EventSummary } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { filterEvents } from './event-filter';

function event(id: string, name: string, venueName: string): EventSummary {
  return {
    id,
    name,
    venueName,
    startsAt: '2027-06-01T19:00:00.000Z',
    strategy: BOOKING_STRATEGY.PESSIMISTIC,
    waitingRoomCapacity: null,
  };
}

const SYMPHONY = event('00000000-0000-4000-8000-0000000000a2', 'Symphony Evening', 'Town Hall');
const JAZZ = event('00000000-0000-4000-8000-0000000000a3', 'Jazz Gala', 'Blue Arena');
const EVENTS = [SYMPHONY, JAZZ];

describe('filterEvents', () => {
  it.each(['', '   '])('returns every event for the query %j', (query) => {
    expect(filterEvents(EVENTS, query)).toEqual(EVENTS);
  });

  it('matches the name regardless of case', () => {
    expect(filterEvents(EVENTS, 'sYMPH')).toEqual([SYMPHONY]);
  });

  it('matches the venue', () => {
    expect(filterEvents(EVENTS, 'arena')).toEqual([JAZZ]);
  });

  it('trims the query', () => {
    expect(filterEvents(EVENTS, '  jazz  ')).toEqual([JAZZ]);
  });

  it('returns nothing when no event matches', () => {
    expect(filterEvents(EVENTS, 'opera')).toEqual([]);
  });

  it.each(['(', '[', '.*'])('treats %j as plain text and does not throw', (query) => {
    expect(filterEvents(EVENTS, query)).toEqual([]);
  });
});
