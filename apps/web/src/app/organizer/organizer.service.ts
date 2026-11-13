import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  type CreateEventRequest,
  CreateEventRequestSchema,
  type EventSummary,
  EventSummarySchema,
  type OrganizerEvent,
  OrganizerEventListResponseSchema,
  type Venue,
  VenueListResponseSchema,
} from '@app/shared';
import { map, type Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class OrganizerService {
  private readonly http = inject(HttpClient);

  venues(): Observable<Venue[]> {
    return this.http.get('/api/venues').pipe(map((body) => VenueListResponseSchema.parse(body)));
  }

  /** Only the caller's own events; the server filters by the owner in the token. */
  events(): Observable<OrganizerEvent[]> {
    return this.http
      .get('/api/organizer/events')
      .pipe(map((body) => OrganizerEventListResponseSchema.parse(body)));
  }

  create(request: CreateEventRequest): Observable<EventSummary> {
    return this.http
      .post('/api/events', CreateEventRequestSchema.parse(request))
      .pipe(map((body) => EventSummarySchema.parse(body)));
  }
}
