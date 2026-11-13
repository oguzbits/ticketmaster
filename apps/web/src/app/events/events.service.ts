import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  type EventDetail,
  EventDetailSchema,
  EventListResponseSchema,
  type EventSummary,
} from '@app/shared';
import { map, type Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class EventsService {
  private readonly http = inject(HttpClient);

  list(): Observable<EventSummary[]> {
    return this.http.get('/api/events').pipe(map((body) => EventListResponseSchema.parse(body)));
  }

  detail(id: string): Observable<EventDetail> {
    return this.http
      .get(`/api/events/${encodeURIComponent(id)}`)
      .pipe(map((body) => EventDetailSchema.parse(body)));
  }
}
