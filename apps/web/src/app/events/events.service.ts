import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  type BookingStrategy,
  type EventDetail,
  EventDetailSchema,
  type EventListQuery,
  type EventListResponse,
  EventListResponseSchema,
  type EventSummary,
  EventSummarySchema,
} from '@app/shared';
import { map, type Observable } from 'rxjs';

export type EventListFilter = Partial<
  Pick<EventListQuery, 'q' | 'from' | 'to' | 'maxPriceCents' | 'cursor' | 'limit'>
>;

@Injectable({ providedIn: 'root' })
export class EventsService {
  private readonly http = inject(HttpClient);

  list(query: EventListFilter = {}): Observable<EventListResponse> {
    let params = new HttpParams();
    if (query.q) params = params.set('q', query.q);
    if (query.from) params = params.set('from', query.from);
    if (query.to) params = params.set('to', query.to);
    if (query.maxPriceCents !== undefined) {
      params = params.set('maxPriceCents', String(query.maxPriceCents));
    }
    if (query.cursor) params = params.set('cursor', query.cursor);
    if (query.limit !== undefined) params = params.set('limit', String(query.limit));
    return this.http
      .get('/api/events', { params })
      .pipe(map((body) => EventListResponseSchema.parse(body)));
  }

  detail(id: string): Observable<EventDetail> {
    return this.http
      .get(`/api/events/${encodeURIComponent(id)}`)
      .pipe(map((body) => EventDetailSchema.parse(body)));
  }

  /** The server decides which events this admin may switch; any other answers 404. */
  setStrategy(id: string, strategy: BookingStrategy): Observable<EventSummary> {
    return this.http
      .patch(`/api/events/${encodeURIComponent(id)}/strategy`, { strategy })
      .pipe(map((body) => EventSummarySchema.parse(body)));
  }

  /** The server decides which events this organizer or admin may change; any other answers 404. */
  setWaitingRoomCapacity(id: string, capacity: number | null): Observable<EventSummary> {
    return this.http
      .put(`/api/events/${encodeURIComponent(id)}/waiting-room/settings`, { capacity })
      .pipe(map((body) => EventSummarySchema.parse(body)));
  }
}
