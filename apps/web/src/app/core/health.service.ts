import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { type HealthResponse, HealthResponseSchema } from '@app/shared';
import { map, type Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class HealthService {
  private readonly http = inject(HttpClient);

  live(): Observable<HealthResponse> {
    return this.http.get('/health/live').pipe(map((body) => HealthResponseSchema.parse(body)));
  }
}
