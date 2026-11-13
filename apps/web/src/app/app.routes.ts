import type { Routes } from '@angular/router';

import { EventList } from './events/event-list';
import { SeatMap } from './events/seat-map';
import { StartPage } from './start/start-page';

export const routes: Routes = [
  { path: '', component: StartPage },
  { path: 'events', component: EventList },
  { path: 'events/:id', component: SeatMap },
];
