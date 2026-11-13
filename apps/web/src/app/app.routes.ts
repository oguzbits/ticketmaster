import type { Routes } from '@angular/router';

import { EventList } from './events/event-list';
import { SeatMap } from './events/seat-map';

export const routes: Routes = [
  { path: '', component: EventList },
  { path: 'events/:id', component: SeatMap },
];
