import { Injectable, signal } from '@angular/core';

/** The query of the header search field, read by the event list. */
@Injectable({ providedIn: 'root' })
export class EventSearchStore {
  readonly query = signal('');
}
