import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { type AuditLogPage, AuditLogPageSchema, type AuditLogQuery } from '@app/shared';
import { map, Observable } from 'rxjs';

type AuditFilter = Partial<Pick<AuditLogQuery, 'action' | 'actorId' | 'cursor'>>;

@Injectable({ providedIn: 'root' })
export class AuditLogService {
  private readonly http = inject(HttpClient);

  /** One page, newest first; `cursor` is the `nextCursor` of the previous page. */
  page(query: AuditFilter): Observable<AuditLogPage> {
    let params = new HttpParams();
    if (query.action) params = params.set('action', query.action);
    if (query.actorId) params = params.set('actorId', query.actorId);
    if (query.cursor) params = params.set('cursor', query.cursor);
    return this.http
      .get('/api/audit-log', { params })
      .pipe(map((body) => AuditLogPageSchema.parse(body)));
  }
}
