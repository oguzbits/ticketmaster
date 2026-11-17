import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  type CreateEventRequest,
  CreateEventRequestSchema,
  type EventSummary,
  EventSummarySchema,
  type OrganizerEvent,
  OrganizerEventListResponseSchema,
  type VenueListQuery,
  type VenueListResponse,
  VenueListResponseSchema,
} from '@app/shared';
import { map, type Observable } from 'rxjs';

export type VenueListFilter = Partial<Pick<VenueListQuery, 'q' | 'cursor' | 'limit'>>;

@Injectable({ providedIn: 'root' })
export class OrganizerService {
  private readonly http = inject(HttpClient);

  venues(query: VenueListFilter = {}): Observable<VenueListResponse> {
    let params = new HttpParams();
    if (query.q) params = params.set('q', query.q);
    if (query.cursor) params = params.set('cursor', query.cursor);
    if (query.limit !== undefined) params = params.set('limit', String(query.limit));
    return this.http
      .get('/api/venues', { params })
      .pipe(map((body) => VenueListResponseSchema.parse(body)));
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
