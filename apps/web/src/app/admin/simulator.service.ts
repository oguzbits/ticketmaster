import { HttpClient } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import {
  SIMULATION_STATUS,
  SimulationListResponseSchema,
  type SimulationProgress,
  SimulationProgressSchema,
  type SimulationRun,
  SimulationRunSchema,
  type SimulationStatus,
  type StartSimulationRequest,
  StartSimulationRequestSchema,
} from '@app/shared';
import { map, Observable } from 'rxjs';

/** The browser's `EventSource`; a token so tests can hand in a fake. */
export const EVENT_SOURCE = new InjectionToken<typeof EventSource>('EventSource', {
  providedIn: 'root',
  factory: () => globalThis.EventSource,
});

const FINAL_STATUSES: readonly SimulationStatus[] = [
  SIMULATION_STATUS.FINISHED,
  SIMULATION_STATUS.FAILED,
];

/** The run stream is public (it needs no token), so the plain `EventSource` is enough. */
@Injectable({ providedIn: 'root' })
export class SimulatorService {
  private readonly http = inject(HttpClient);
  private readonly eventSource = inject(EVENT_SOURCE);

  start(request: StartSimulationRequest): Observable<SimulationRun> {
    return this.http
      .post('/api/simulations', StartSimulationRequestSchema.parse(request))
      .pipe(map((body) => SimulationRunSchema.parse(body)));
  }

  /** The latest finished runs, newest first. */
  list(): Observable<SimulationRun[]> {
    return this.http
      .get('/api/simulations')
      .pipe(map((body) => SimulationListResponseSchema.parse(body)));
  }

  /**
   * Progress of one run; completes after FINISHED or FAILED. While the browser reconnects after a
   * dropped connection nothing happens (the server answers with the current state); when it gives
   * up the Observable fails and the view offers a retry.
   */
  progress(runId: string): Observable<SimulationProgress> {
    return new Observable((subscriber) => {
      const source = new this.eventSource(`/api/simulations/${encodeURIComponent(runId)}/stream`);
      source.onmessage = (event: MessageEvent<string>) => {
        const parsed = SimulationProgressSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) {
          subscriber.error(parsed.error);
          return;
        }
        subscriber.next(parsed.data);
        if (FINAL_STATUSES.includes(parsed.data.status)) subscriber.complete();
      };
      source.onerror = () => {
        if (source.readyState === this.eventSource.CLOSED) {
          subscriber.error(new Error('The progress stream was closed'));
        }
      };
      return () => source.close();
    });
  }
}
